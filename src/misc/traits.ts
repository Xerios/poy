export type Impl<T> = Record<string, any> & T;

export type Eq<T> = { eq: (a: T, b: T) => boolean };

export type Show<T> = { show: (self: T) => string };

export type From<Source, Target> = { from: (self: Source) => Target };

export type Rewrite<T, Into = T> = {
    rewrite: (self: T, f: (v: T) => Into) => Into;
};
