import { DataType, genConstructors } from "itsamatch";
import { Type } from "../../infer/type";
import { BinaryOp, Literal, UnaryOp } from "../../parse/token";
import { FunctionArgument } from "./decl";
import { Stmt } from "./stmt";

type Typed<T> = { [K in keyof T]: T[K] & { ty: Type } };

export type Expr = DataType<Typed<{
    Literal: { literal: Literal },
    Variable: { name: string },
    Unary: { op: UnaryOp, expr: Expr },
    Binary: { lhs: Expr, op: BinaryOp, rhs: Expr },
    Block: { stmts: Stmt[], ret?: Expr },
    If: { cond: Expr, then: Expr, otherwise?: Expr },
    Tuple: { elems: Expr[] },
    Array: { elems: Expr[] },
    UseIn: { name: string, value: Expr, rhs: Expr },
    Fun: { args: FunctionArgument[], body: Expr },
    Call: { fun: Expr, args: Expr[] },
    Path: { path: string[], member: string },
    Struct: { path: string[], name: string, fields: { name: string, value: Expr }[] },
    Dot: { lhs: Expr, field: string },
}>>;

export const Expr = {
    ...genConstructors<Expr>([
        'Variable', 'Unary', 'Binary', 'Block', 'If', 'Tuple', 'Array',
        'UseIn', 'Fun', 'Call', 'Struct',
    ]),
    Literal: (literal: Literal, ty: Type): Expr => ({ variant: 'Literal', literal, ty }) as const,
    Path: (path: string[], member: string, ty: Type): Expr => ({ variant: 'Path', path, member, ty }) as const,
    Dot: (lhs: Expr, field: string, ty: Type): Expr => ({ variant: 'Dot', lhs, field, ty }) as const,
};
