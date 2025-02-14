import { DataType, genConstructors, match } from 'itsamatch';
import { TypeEnv } from '../../infer/infer';
import { Type } from '../../infer/type';
import { BinaryOp, Literal, UnaryOp } from '../../parse/token';
import { Stmt } from './stmt';
import { Pattern } from './pattern';

export type Expr = DataType<{
    Literal: { literal: Literal };
    Variable: { name: string; typeParams: Type[] };
    Unary: { op: UnaryOp; expr: Expr };
    Binary: { lhs: Expr; op: BinaryOp; rhs: Expr };
    Block: { stmts: Stmt[]; ret?: Expr };
    If: { cond: Expr; then: Expr; otherwise?: Expr };
    Tuple: { elems: Expr[] };
    Array: { elems: Expr[] };
    UseIn: { name: string; ann?: Type; value: Expr; rhs: Expr };
    Fun: {
        generics: string[];
        args: FunctionArgument[];
        ret?: Type;
        body: Expr;
        isIterator: boolean;
    };
    Call: { fun: Expr; args: Expr[] };
    Struct: {
        path: string[];
        name: string;
        typeParams: Type[];
        fields: { name: string; value: Expr }[];
    };
    VariableAccess: {
        lhs: Expr;
        field: string;
        typeParams: Type[];
        extensionUuid?: string;
        isCalled: boolean;
        isNative: boolean;
    };
    ModuleAccess: { path: string[]; member: string; extensionUuid?: string };
    ExtensionAccess: {
        subject: Type;
        member: string;
        typeParams: Type[];
        extensionUuid?: string;
    };
    TupleAccess: { lhs: Expr; index: number };
    Match: { subject: Expr; cases: { pattern: Pattern; body: Expr }[] };
}> & { ty?: Type };

export type FunctionArgument = { name: string; ann?: Type };

export const Expr = {
    ...genConstructors<Expr>([
        'Variable',
        'Unary',
        'Binary',
        'Block',
        'If',
        'Tuple',
        'Array',
        'UseIn',
        'Fun',
        'Call',
        'Struct',
        'VariableAccess',
        'ExtensionAccess',
        'ModuleAccess',
        'TupleAccess',
        'Match',
    ]),
    Literal: (literal: Literal): Expr =>
        ({ variant: 'Literal', literal }) as const,
    isMutable: (expr: Expr, env: TypeEnv): boolean => {
        return match(expr, {
            Variable: ({ name }) =>
                env.variables.lookup(name).unwrap().mut ?? false,
            VariableAccess: ({ lhs, field }) => {
                if (!Expr.isMutable(lhs, env)) return false;
                if (lhs.ty === undefined) return false;
                if (lhs.ty.variant === 'Fun') {
                    return env.structs.lookup(lhs.ty.name).match({
                        Some: struct => {
                            const fieldInfo = struct.fields.find(
                                f => f.name === field,
                            );
                            return fieldInfo?.mut ?? false;
                        },
                        None: () => false,
                    });
                }

                return false;
            },
            Array: () => true,
            Struct: () => true,
            _: () => false,
        });
    },
    // can this expression be copied without any side effects?
    isPurelyCopyable: (expr: Expr): boolean =>
        match(expr, {
            Variable: () => true,
            Literal: () => true,
            _: () => false,
        }),
};
