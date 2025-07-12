import { ResolveHookContext } from 'node:module';

declare function resolve(specifier: string, context: ResolveHookContext, nextResolve: (specifier: string, context: ResolveHookContext) => Promise<{
    url: string;
}>): Promise<{
    url: string;
}>;

export { resolve };
