import { DataType, genConstructors } from 'itsamatch';
import { Type } from '../../infer/type';
import { BinaryOp, Literal, UnaryOp } from '../../parse/token';
import { Stmt } from './stmt';

export type Expr = DataType<{
    Literal: { literal: Literal },
    Variable: string,
    Unary: { op: UnaryOp, expr: Expr },
    Binary: { lhs: Expr, op: BinaryOp, rhs: Expr },
    Block: { stmts: Stmt[], ret?: Expr },
    If: { cond: Expr, then: Expr, otherwise: Expr },
    Tuple: { elems: Expr[] },
    Array: { elems: Expr[] },
    UseIn: { name: string, ann?: Type, value: Expr, rhs: Expr },
    Fun: { args: FunctionArgument[], ret?: Type, body: Expr },
    Call: { fun: Expr, args: Expr[] },
    Path: { path: string[], member: string },
}> & { ty?: Type };

export type FunctionArgument = { name: string, ann?: Type };

export const Expr = {
    ...genConstructors<Expr>([
        'Variable', 'Unary', 'Binary', 'Block', 'If', 'Tuple', 'Array',
        'UseIn', 'Fun', 'Call',
    ]),
    Literal: (literal: Literal): Expr => ({ variant: 'Literal', literal }) as const,
    Path: (path: string[], member: string): Expr => ({ variant: 'Path', path, member }) as const,
};
