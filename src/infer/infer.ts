import { match, VariantOf } from "itsamatch";
import { Decl, StructDecl } from "../ast/sweet/decl";
import { Expr } from "../ast/sweet/expr";
import { Stmt } from "../ast/sweet/stmt";
import { Maybe } from "../misc/maybe";
import { Scope, TypeParamScope } from "../misc/scope";
import { setDifference, uniq } from "../misc/sets";
import { last, panic, proj, zip } from "../misc/utils";
import { AssignmentOp, BinaryOp, UnaryOp } from "../parse/token";
import { Module, ModulePath, Resolver } from "../resolve/resolve";
import { ExtensionScope } from "./extensions";
import { TRS } from "./rewrite";
import { Subst, Type, TypeVar } from "./type";

type VarInfo = { pub: boolean, mutable: boolean, generics?: string[], ty: Type };
type ModuleInfo = Module & { local: boolean };

export class TypeEnv {
    public variables: Scope<VarInfo>;
    public modules: Scope<ModuleInfo>;
    private structs: Scope<StructDecl>;
    public generics: TypeParamScope;
    public typeRules: TRS;
    private typeImports: Map<string, ModulePath>;
    private extensions: ExtensionScope;
    public letLevel: number;
    private functionStack: Type[];
    private resolver: Resolver;
    private modulePath: string;
    private moduleName: string;

    constructor(resolver: Resolver, modulePath: string, moduleName: string, parent?: TypeEnv) {
        this.resolver = resolver;
        this.variables = new Scope(parent?.variables);
        this.modules = new Scope(parent?.modules);
        this.structs = new Scope(parent?.structs);
        this.generics = new TypeParamScope(parent?.generics);
        this.typeRules = TRS.create(parent?.typeRules);
        this.typeImports = new Map(parent?.typeImports);
        this.extensions = new ExtensionScope(parent?.extensions);
        this.letLevel = parent?.letLevel ?? 0;
        this.functionStack = [...parent?.functionStack ?? []];
        this.modulePath = modulePath;
        this.moduleName = moduleName;
    }

    public child(): TypeEnv {
        return new TypeEnv(this.resolver, this.modulePath, this.modulePath, this);
    }

    public freshType(): Type {
        return Type.fresh(this.letLevel);
    }

    public normalize(ty: Type): Type {
        return TRS.normalize(this, ty);
    }

    private unify(s: Type, t: Type): void {
        const unifiable = Type.unify(this.normalize(s), this.normalize(t), this.generics);

        if (!unifiable) {
            panic(`Cannot unify '${Type.show(s)}' with '${Type.show(t)}'`);
        }
    }

    private inferLet(
        pub: boolean,
        mutable: boolean,
        name: string,
        ann: Type | undefined,
        value: Expr
    ): Type {
        this.letLevel += 1;

        let ty: Type;
        const rhsEnv = this.child();
        let generics: string[] | undefined;

        if (value.variant === 'Fun') {
            generics = value.generics;
            const recTy = rhsEnv.freshType();
            rhsEnv.variables.declare(name, { pub, mutable, generics: value.generics, ty: recTy });
            const funTy = rhsEnv.inferFun(value);
            const funTyInst = Type.instantiate(funTy, rhsEnv.letLevel, rhsEnv.generics).ty;
            rhsEnv.unify(funTyInst, recTy);
            ty = funTy;
        } else {
            ty = rhsEnv.inferExpr(value);
        }

        if (ann) {
            rhsEnv.unify(ann, ty);
        }

        this.letLevel -= 1;

        // https://en.wikipedia.org/wiki/Value_restriction
        const genTy = mutable ? ty : Type.generalize(ty, this.letLevel);
        this.variables.declare(name, { pub, mutable, generics, ty: genTy });

        return genTy;
    }

    private inferFun(fun: VariantOf<Expr, 'Fun'>): Type {
        const { generics, args, body, ret } = fun;
        const params = generics.map(() => this.freshType());
        this.generics.declareMany(zip(generics, params));

        const argTys = args.map(arg => arg.ann ?? this.freshType());
        const returnTy = ret ?? this.freshType();
        this.functionStack.push(returnTy);

        args.forEach(({ name }, i) => {
            this.variables.declare(name, {
                pub: false,
                mutable: false,
                ty: this.resolveType(argTys[i]),
                generics,
            });

            args[i].ann = argTys[i];
        });

        return TypeVar.recordSubstitutions(subst => {
            const bodyTy = this.inferExpr(body);
            this.unify(bodyTy, returnTy);
            this.generics.substitute(subst);
            this.functionStack.pop();
            let funTy = Type.Function(argTys, bodyTy)
            funTy = Type.substitute(funTy, subst);
            funTy = Type.parameterize(funTy, this.generics);
            fun.ty = funTy;
            return funTy;
        });
    }

    public async inferDecl(decl: Decl): Promise<void> {
        await match(decl, {
            Stmt: ({ stmt }) => {
                this.inferStmt(stmt);
            },
            Type: ({ pub, lhs, rhs }) => {
                TRS.add(
                    this.typeRules,
                    this.resolveType(lhs),
                    this.resolveType(rhs),
                    pub
                );
            },
            Struct: struct => {
                for (const field of struct.fields) {
                    field.ty = Type.generalize(field.ty, this.letLevel);
                }

                this.structs.declare(struct.name, struct);
            },
            Declare: ({ sig }) => match(sig, {
                Variable: ({ mutable, name, ty }) => {
                    const genTy = mutable ? ty : Type.generalize(ty, this.letLevel);
                    this.variables.declare(name, { pub: true, mutable, ty: genTy });
                },
                Module: ({ name, signatures }) => {
                    const moduleEnv = this.child();
                    const decls = signatures.map(sig => Decl.Declare(sig));
                    this.modules.declare(name, {
                        pub: true,
                        local: true,
                        name,
                        env: moduleEnv,
                        decls
                    });

                    for (const decl of decls) {
                        moduleEnv.inferDecl(decl);
                    }
                },
                Type: ({ pub, lhs, rhs }) => {
                    TRS.add(
                        this.typeRules,
                        this.resolveType(lhs),
                        this.resolveType(rhs),
                        pub
                    );
                },
            }),
            Module: ({ pub, name, decls }) => {
                const moduleEnv = this.child();
                this.modules.declare(name, { pub, local: true, name, env: moduleEnv, decls });

                for (const decl of decls) {
                    moduleEnv.inferDecl(decl);
                }
            },
            Import: async ({ path, module, members }) => {
                const moduleDir = this.resolver.fs.directoryName(this.modulePath);
                const fullPath = this.resolver.fs.join(moduleDir, ...path, `${module}.poy`);
                const mod = await this.resolver.resolve(fullPath);

                this.modules.declare(module, { ...mod, local: false });

                if (members) {
                    for (const member of members) {
                        const name = member.name;
                        mod.env.variables.lookup(name).match({
                            Some: ({ pub, mutable, ty }) => {
                                member.kind = 'value';

                                if (pub) {
                                    this.variables.declare(name, { pub, mutable, ty });
                                } else {
                                    panic(`Cannot import private variable '${name}' from module '${module}'`);
                                }
                            },
                            None: () => {
                                mod.env.modules.lookup(name).match({
                                    Some: (module) => {
                                        member.kind = 'module';

                                        if (module.pub) {
                                            this.modules.declare(name, { ...module, local: false });
                                        } else {
                                            panic(`Cannot import private module '${name}' from module '${module}'`);
                                        }
                                    },
                                    None: () => {
                                        Maybe.wrap(mod.env.typeRules.get(name)).match({
                                            Some: rules => {
                                                member.kind = 'type';

                                                const somePubRules = rules.some(rule => rule.pub);
                                                const somePrivateRules = rules.some(rule => !rule.pub);
                                                if (somePubRules && somePrivateRules) {
                                                    panic(`Cannot import partially public type '${name}' from module '${module}'`);
                                                }

                                                if (somePrivateRules) {
                                                    panic(`Cannot import private type '${name}' from module '${module}'`);
                                                }

                                                this.typeImports.set(name, { file: fullPath, subpath: path });
                                            },
                                            None: () => {
                                                mod.env.structs.lookup(name).match({
                                                    Some: struct => {
                                                        member.kind = 'type';

                                                        if (struct.pub) {
                                                            this.structs.declare(name, struct);
                                                        } else {
                                                            panic(`Cannot import private struct '${name}' from module '${module}'`);
                                                        }
                                                    },
                                                    None: () => {
                                                        panic(`Cannot find member '${name}' in module '${module}'`)
                                                    }
                                                });
                                            },
                                        });
                                    },
                                });
                            },
                        });
                    }
                }
            },
            Extend: ({ subject, decls, uuid }) => {
                TypeVar.recordSubstitutions(globalSubst => {
                    subject = Type.generalize(subject, this.letLevel);
                    const globalGenerics = [...Type.namedParams(subject)];

                    const extend = (decl: Decl): void => {
                        const extEnv = this.child();
                        extEnv.generics.declareMany(zip(globalGenerics, globalGenerics.map(name => Type.fresh(this.letLevel, name))));
                        extEnv.variables.declare('self', { pub: false, mutable: false, ty: subject });
                        extEnv.typeRules.set('Self', [{
                            pub: false,
                            lhs: Type.Fun('Self', [], { file: this.modulePath, subpath: [], env: extEnv }),
                            rhs: subject,
                        }]);

                        if (decl.variant === 'Stmt' && decl.stmt.variant === 'Let') {
                            const { pub, mutable, static: isStatic, name, ann, value } = decl.stmt;
                            const generics: string[] = [];

                            if (value.variant === 'Fun') {
                                generics.push(...value.generics);
                            }

                            const ty = extEnv.inferLet(pub, mutable, name, ann, value);
                            extEnv.generics.substitute(globalSubst);
                            const genTy = Type.parameterize(mutable ? ty : Type.generalize(ty, this.letLevel), extEnv.generics);
                            const subjectTy = Type.parameterize(
                                Type.generalize(
                                    Type.substitute(
                                        extEnv.resolveType(subject), globalSubst),
                                    this.letLevel - 1
                                ),
                                extEnv.generics
                            );

                            this.extensions.declare({
                                subject: subjectTy,
                                member: name,
                                generics,
                                ty: genTy,
                                declared: false,
                                static: isStatic,
                                uuid,
                            });
                        } else if (decl.variant === 'Declare' && decl.sig.variant === 'Variable') {
                            let { mutable, name, ty, static: isStatic } = decl.sig;
                            ty = Type.substitute(ty, globalSubst);
                            const genTy = mutable ? ty : Type.generalize(ty, this.letLevel);

                            this.extensions.declare({
                                subject: Type.generalize(Type.substitute(subject, globalSubst), this.letLevel),
                                member: name,
                                generics: uniq([...globalGenerics, ...decl.sig.generics]),
                                ty: genTy,
                                declared: true,
                                static: isStatic,
                                uuid,
                            });
                        } else if (decl.variant === '_Many') {
                            decl.decls.forEach(extend);
                        } else {
                            panic(`Cannot extend a type with a '${decl.variant}' declaration`);
                        }
                    };

                    decls.forEach(extend);
                });
            },
            _Many: ({ decls }) => {
                for (const decl of decls) {
                    this.inferDecl(decl);
                }
            },
        });
    }

    public inferStmt(stmt: Stmt): void {
        match(stmt, {
            Expr: ({ expr }) => {
                this.inferExpr(expr);
            },
            Let: ({ pub, mutable, name, ann, value }) => {
                const generics: string[] = [];

                if (value.variant === 'Fun') {
                    generics.push(...value.generics);
                }

                this.inferLet(pub, mutable, name, ann, value);
            },
            Assign: ({ lhs, op, rhs }) => {
                const alpha = Type.Var(TypeVar.Generic({ id: 0 }));
                const ASSIGNMENT_OP_TYPE: Record<AssignmentOp, [Type, Type]> = {
                    '=': [alpha, alpha],
                    '+=': [Type.Num, Type.Num],
                    '-=': [Type.Num, Type.Num],
                    '*=': [Type.Num, Type.Num],
                    '/=': [Type.Num, Type.Num],
                    'mod=': [Type.Num, Type.Num],
                    '**=': [Type.Num, Type.Num],
                    'or=': [Type.Num, Type.Num],
                    'and=': [Type.Num, Type.Num],
                    '|=': [Type.Num, Type.Num],
                    '&=': [Type.Num, Type.Num],
                };

                const [expectedLhsTy, expectedRhsTy] = ASSIGNMENT_OP_TYPE[op].map(ty =>
                    Type.instantiate(ty, this.letLevel, this.generics)
                );

                const lhsTy = this.inferExpr(lhs);
                const rhsTy = this.inferExpr(rhs);

                this.unify(lhsTy, expectedLhsTy.ty);
                this.unify(rhsTy, expectedRhsTy.ty);

                this.unify(lhsTy, rhsTy);
            },
            While: ({ cond, body }) => {
                this.unify(this.inferExpr(cond), Type.Bool);

                const bodyEnv = this.child();
                for (const stmt of body) {
                    bodyEnv.inferStmt(stmt);
                }
            },
            Return: ({ expr }) => {
                if (this.functionStack.length === 0) {
                    panic('Return statement used outside of a function body');
                }

                const funReturnTy = last(this.functionStack);
                const exprTy = this.inferExpr(expr);
                this.unify(funReturnTy, exprTy);
            },
            _Many: ({ stmts }) => {
                for (const stmt of stmts) {
                    this.inferStmt(stmt);
                }
            },
        });
    }

    private parametrize(
        generics: string[],
        infer: (scope: TypeParamScope) => { ty: Type, subst: Subst }
    ): { ty: Type, params: Map<string, Type> } {
        const params = generics.map(name => Type.fresh(this.letLevel, name));
        const scope = this.generics.child();
        scope.declareMany(zip(generics, params));
        const { ty, subst } = infer(scope);
        scope.substitute(subst);
        const mapping = Subst.parameterize(subst, scope.reversed);
        return { ty, params: mapping };
    }

    private validateTypeParameters(kind: string, name: string, generics: string[] | undefined, typeParams: Type[]) {
        if (typeParams.length > 0 && generics == null) {
            panic(`${kind} '${name}' expects no type parameters, but ${typeParams.length} were given.`);
        }

        if (generics != null && typeParams.length > 0 && typeParams.length !== generics.length) {
            panic(`${kind} '${name}' expects ${generics.length} type parameters, but ${typeParams.length} were given.`);
        }
    }

    public inferExpr(expr: Expr): Type {
        if (expr.ty) return expr.ty;

        const ty = match(expr, {
            Literal: ({ literal }) => Type[literal.variant],
            Variable: ({ name, typeParams }) => this.variables.lookup(name).match({
                Some: ({ ty, generics }) => {
                    this.validateTypeParameters('Variable', name, generics, typeParams);
                    let typeParamScope = this.generics;

                    if (generics != null && generics.length > 0) {
                        typeParamScope = this.generics.child();
                        typeParamScope.declareMany(zip(
                            generics,
                            typeParams.length > 0 ? typeParams : generics.map(name => Type.fresh(this.letLevel, name))
                        ));
                    }

                    return Type.instantiate(ty, this.letLevel, typeParamScope).ty;
                },
                None: () => panic(`Variable ${name} not found`),
            }),
            Unary: ({ op, expr }) => {
                const exprTy = this.inferExpr(expr);
                const UNARY_OP_TYPE: Record<UnaryOp, Type> = {
                    '!': Type.Bool,
                    '-': Type.Num,
                    '+': Type.Num,
                };

                this.unify(exprTy, UNARY_OP_TYPE[op]);

                return exprTy;
            },
            Binary: ({ lhs, op, rhs }) => {
                const lhsTy = this.inferExpr(lhs);
                const rhsTy = this.inferExpr(rhs);

                const BINARY_OP_TYPE: Record<BinaryOp, [Type, Type, Type]> = {
                    '+': [Type.Num, Type.Num, Type.Num],
                    '-': [Type.Num, Type.Num, Type.Num],
                    '*': [Type.Num, Type.Num, Type.Num],
                    '/': [Type.Num, Type.Num, Type.Num],
                    'mod': [Type.Num, Type.Num, Type.Num],
                    '**': [Type.Num, Type.Num, Type.Num],
                    '==': [Type.Var(TypeVar.Generic({ id: 0 })), Type.Var(TypeVar.Generic({ id: 0 })), Type.Bool],
                    '!=': [Type.Var(TypeVar.Generic({ id: 0 })), Type.Var(TypeVar.Generic({ id: 0 })), Type.Bool],
                    '<': [Type.Num, Type.Num, Type.Bool],
                    '>': [Type.Num, Type.Num, Type.Bool],
                    '<=': [Type.Num, Type.Num, Type.Bool],
                    '>=': [Type.Num, Type.Num, Type.Bool],
                    'and': [Type.Bool, Type.Bool, Type.Bool],
                    'or': [Type.Bool, Type.Bool, Type.Bool],
                    '&': [Type.Num, Type.Num, Type.Num],
                    '|': [Type.Num, Type.Num, Type.Num],
                };

                const [lhsExpected, rhsExpected, retTy] = BINARY_OP_TYPE[op].map(ty =>
                    Type.instantiate(ty, this.letLevel, this.generics)
                );

                this.unify(lhsTy, lhsExpected.ty);
                this.unify(rhsTy, rhsExpected.ty);

                return retTy.ty;
            },
            Block: ({ stmts, ret }) => {
                const blockEnv = this.child();

                for (const stmt of stmts) {
                    blockEnv.inferStmt(stmt);
                }

                if (ret) {
                    return blockEnv.inferExpr(ret);
                } else {
                    return Type.Unit;
                }
            },
            Array: ({ elems }) => {
                const elemTy = this.freshType();

                for (const elem of elems) {
                    this.unify(elemTy, this.inferExpr(elem));
                }

                return Type.Array(elemTy);
            },
            Fun: fun => {
                const funEnv = this.child();
                const ty = Type.instantiate(funEnv.inferFun(fun), this.letLevel, this.generics).ty;
                return ty;
            },
            Call: ({ fun, args }) => {
                const funTy = this.inferExpr(fun);
                const argTys = args.map(arg => this.inferExpr(arg));
                const retTy = this.freshType();
                const expectedFunTy = Type.Function(argTys, retTy);
                this.unify(funTy, expectedFunTy);

                return retTy;
            },
            If: ({ cond, then, otherwise }) => {
                this.unify(this.inferExpr(cond), Type.Bool);
                const thenTy = this.inferExpr(then);

                if (otherwise) {
                    const elseTy = this.inferExpr(otherwise);
                    this.unify(thenTy, elseTy);
                } else {
                    this.unify(thenTy, Type.Unit);
                }

                return thenTy;
            },
            Tuple: ({ elems }) => {
                const elemTys = elems.map(elem => this.inferExpr(elem));
                return Type.Tuple(elemTys);
            },
            UseIn: ({ name, ann, value, rhs }) => {
                const rhsEnv = this.child();
                rhsEnv.inferLet(false, false, name, ann, value);
                return rhsEnv.inferExpr(rhs);
            },
            ModuleAccess: moduleAccessExpr => {
                const { path, member } = moduleAccessExpr;
                let mod: ModuleInfo = {
                    pub: true,
                    local: true,
                    name: this.moduleName,
                    env: this,
                    decls: [],
                };

                path.forEach((name, index) => {
                    mod = mod.env.modules.lookup(name).unwrap();

                    if (!mod.local && !mod.pub) {
                        panic(`Module ${path.slice(0, index).join('.')} is private`);
                    }
                });

                const { pub, ty } = mod.env.variables.lookup(member).unwrap();

                if (!mod.local && !pub) {
                    panic(`Member ${path.join('.')}.${member} is private`);
                }

                return ty;
            },
            Struct: ({ name, typeParams, fields }) => {
                const decl = this.structs.lookup(name).unwrap(`Struct '${name}' not found`);
                const fieldTys = new Map(fields.map(({ name, value }) => [name, this.inferExpr(value)]));
                const expectedFields = new Set(decl.fields.map(proj('name')));
                const actualFields = new Set(fieldTys.keys());

                const missingFields = setDifference(expectedFields, actualFields);
                if (missingFields.size > 0) {
                    panic(`Missing field(s) in '${name}' struct expression: ${[...missingFields].join(', ')}`);
                }

                const extraFields = setDifference(actualFields, expectedFields);
                if (extraFields.size > 0) {
                    panic(`Extra field(s) in '${name}' struct expression: ${[...extraFields].join(', ')}`);
                }

                const structParamsScope = this.generics.child();
                const paramsInst = typeParams.length > 0 ? typeParams : decl.params.map(() => this.freshType());
                structParamsScope.declareMany(zip(decl.params, paramsInst));

                for (const { name, ty } of decl.fields) {
                    this.unify(fieldTys.get(name)!, Type.instantiate(ty, this.letLevel, structParamsScope).ty);
                }

                return Type.Fun(name, paramsInst, { file: this.modulePath, subpath: [], env: this });
            },
            VariableAccess: dotExpr => {
                const { lhs, field, typeParams, isCalled } = dotExpr;
                const lhsTy = this.inferExpr(lhs);

                if (lhsTy.variant === 'Fun' && this.structs.has(lhsTy.name)) {
                    const decl = this.structs.lookup(lhsTy.name);
                    if (decl.isSome()) {
                        const structDecl = decl.unwrap();
                        const fieldInfo = structDecl.fields.find(({ name }) => name === field);
                        this.validateTypeParameters('Struct', lhsTy.name, structDecl.params, typeParams);
                        const params = zip(
                            structDecl.params,
                            typeParams.length > 0 ? typeParams : structDecl.params.map(() => this.freshType())
                        );

                        this.generics.declareMany(params);

                        if (fieldInfo) {
                            return Type.instantiate(fieldInfo.ty, this.letLevel, this.generics).ty;
                        }
                    }
                }

                return this.extensions.lookup(lhsTy, field, this).match({
                    Ok: ({ ext: { ty: memberTy, generics, declared: isNative, uuid, subject }, subst, params }) => {
                        dotExpr.extensionUuid = uuid;
                        dotExpr.isNative = isNative;

                        if (isNative && !isCalled && Type.utils.isFunction(memberTy)) {
                            return panic(`Declared member '${field}' from extension of '${Type.show(lhsTy)}' must be called`);
                        }

                        this.validateTypeParameters('Member', field, generics, typeParams);
                        const typeParamScope = this.generics.child();
                        typeParamScope.declareMany([...params.entries()]);
                        typeParamScope.declareMany(zip(
                            generics,
                            typeParams.length === generics.length ?
                                typeParams :
                                generics.map(name => Type.fresh(this.letLevel, name))
                        ));
                        const subjectInst = Type.instantiate(Type.substitute(subject, subst), this.letLevel, typeParamScope);
                        const extInst = Type.instantiate(Type.substituteMany(memberTy, [subjectInst.subst, subst]), this.letLevel, typeParamScope);
                        this.unify(lhsTy, subjectInst.ty);

                        return extInst.ty;
                    },
                    Error: panic,
                });
            },
            ExtensionAccess: extensionAccessExpr => {
                const { subject, typeParams, member } = extensionAccessExpr;
                extensionAccessExpr.subject = this.resolveType(subject);
                const subjectInst = Type.instantiate(subject, this.letLevel, this.generics);
                const ext = this.extensions.lookup(subjectInst.ty, member, this);

                return ext.match({
                    Ok: ({ ext: { ty, uuid, declared, static: isStatic, generics }, subst, params }) => {
                        if (declared) {
                            return panic(`Cannot access a declared extension member with an extension access expression: '${Type.show(subject)}::${member}'`);
                        }

                        const typeParamScope = this.generics.child();
                        typeParamScope.declareMany([...params.entries()]);
                        typeParamScope.declareMany(zip(generics, typeParams));
                        const instTy = Type.instantiate(Type.substitute(ty, subst), this.letLevel, typeParamScope).ty;
                        extensionAccessExpr.extensionUuid = uuid;

                        if (!isStatic && Type.utils.isFunction(instTy)) {
                            // prepend 'self' to the function's type
                            const selfTy = Type.substitute(subjectInst.ty, subst);
                            const params = [selfTy, ...Type.utils.parameters(instTy)];
                            const ret = Type.utils.returnType(instTy);
                            return Type.Fun('Function', [Type.utils.list(params), ret]);
                        }

                        return instTy;
                    },
                    Error: panic,
                });
            },
            TupleAccess: ({ lhs, index }) => {
                let elems = Type.fresh(this.letLevel);
                const expectedLhsTy = Type.Fun('Tuple', [elems]);
                const lhsTy = this.inferExpr(lhs);
                this.unify(lhsTy, expectedLhsTy);
                elems = Type.utils.unlink(elems);

                if (Type.utils.isList(elems)) {
                    const elemTys = Type.utils.unlist(elems);
                    if (index >= elemTys.length) {
                        return panic(`Tuple index out of bounds: ${index} >= ${elemTys.length}`);
                    }

                    return elemTys[index];
                } else {
                    return panic(`Expected tuple type, got '${Type.show(lhsTy)}'`);
                }
            },
        });

        expr.ty = ty;
        return ty;
    }

    public show(indent = 0): string {
        return '\n' + [
            'Variables:',
            this.variables.show(({ ty }) => Type.show(ty)),
            'Modules:',
            this.modules.show(({ env }) => env.show(indent + 1)),
        ].map(str => '  '.repeat(indent) + str).join('\n');
    }

    public resolveModuleEnv(file: string, subpath?: string[]): TypeEnv {
        let env = file === this.modulePath ? this : this.resolver.modules.get(file)!.env;

        if (subpath) {
            subpath.forEach(name => {
                env = env.modules.lookup(name).unwrap(`Module ${name} not found`).env;
            });
        }

        return env;
    }

    public resolveType(ty: Type): Type {
        return Type.rewrite(ty, t => match(t, {
            Var: v => {
                if (v.ref.variant === 'Param') {
                    if (v.ref.name[0] === '_') {
                        return Type.fresh(this.letLevel);
                    }

                    return this.resolveType(this.generics.lookup(v.ref.name).unwrap(`Type parameter '${v.ref.name}' not found (resolveType)`));
                }

                return v;
            },
            Fun: ({ name, args, path }) => {
                let modulePath: ModulePath | undefined = this.typeRules.has(name) ? path : this.typeImports.get(name) ?? path;
                modulePath ??= { file: this.modulePath, subpath: [] };
                modulePath.env = path?.env ?? this.resolveModuleEnv(modulePath.file, modulePath.subpath);

                return Type.Fun(
                    name,
                    args.map(arg => this.resolveType(arg)),
                    modulePath,
                );
            },
        }));
    }
}
