import { StateMachine } from "./StateMachine.js";
import { GuardPredicate } from "./guards.js";
import { ActionFunction, AnyActorRef, AnyEventObject, Cast, DelayConfig, EventObject, Invert, IsNever, MachineConfig, MachineContext, MetaObject, NonReducibleUnknown, ParameterizedObject, SetupTypes, ToChildren, ToStateValue, UnknownActorLogic, Values } from "./types.js";
type ToParameterizedObject<TParameterizedMap extends Record<string, ParameterizedObject['params'] | undefined>> = IsNever<TParameterizedMap> extends true ? never : Values<{
    [K in keyof TParameterizedMap & string]: {
        type: K;
        params: TParameterizedMap[K];
    };
}>;
type ToProvidedActor<TChildrenMap extends Record<string, string>, TActors extends Record<string, UnknownActorLogic>> = IsNever<TActors> extends true ? never : Values<{
    [K in keyof TActors & string]: {
        src: K;
        logic: TActors[K];
        id: IsNever<TChildrenMap> extends true ? string | undefined : K extends keyof Invert<TChildrenMap> ? Invert<TChildrenMap>[K] & string : string | undefined;
    };
}>;
type RequiredSetupKeys<TChildrenMap> = IsNever<keyof TChildrenMap> extends true ? never : 'actors';
export declare function setup<TContext extends MachineContext, TEvent extends AnyEventObject, // TODO: consider using a stricter `EventObject` here
TActors extends Record<string, UnknownActorLogic> = {}, TChildrenMap extends Record<string, string> = {}, TActions extends Record<string, ParameterizedObject['params'] | undefined> = {}, TGuards extends Record<string, ParameterizedObject['params'] | undefined> = {}, TDelay extends string = never, TTag extends string = string, TInput = NonReducibleUnknown, TOutput extends NonReducibleUnknown = NonReducibleUnknown, TEmitted extends EventObject = EventObject, TMeta extends MetaObject = MetaObject>({ schemas, actors, actions, guards, delays }: {
    schemas?: unknown;
    types?: SetupTypes<TContext, TEvent, TChildrenMap, TTag, TInput, TOutput, TEmitted, TMeta>;
    actors?: {
        [K in keyof TActors | Values<TChildrenMap>]: K extends keyof TActors ? TActors[K] : never;
    };
    actions?: {
        [K in keyof TActions]: ActionFunction<TContext, TEvent, TEvent, TActions[K], ToProvidedActor<TChildrenMap, TActors>, ToParameterizedObject<TActions>, ToParameterizedObject<TGuards>, TDelay, TEmitted>;
    };
    guards?: {
        [K in keyof TGuards]: GuardPredicate<TContext, TEvent, TGuards[K], ToParameterizedObject<TGuards>>;
    };
    delays?: {
        [K in TDelay]: DelayConfig<TContext, TEvent, ToParameterizedObject<TActions>['params'], TEvent>;
    };
} & {
    [K in RequiredSetupKeys<TChildrenMap>]: unknown;
}): {
    createMachine: <const TConfig extends MachineConfig<TContext, TEvent, ToProvidedActor<TChildrenMap, TActors>, ToParameterizedObject<TActions>, ToParameterizedObject<TGuards>, TDelay, TTag, TInput, TOutput, TEmitted, TMeta>>(config: TConfig) => StateMachine<TContext, TEvent, Cast<ToChildren<ToProvidedActor<TChildrenMap, TActors>>, Record<string, AnyActorRef | undefined>>, ToProvidedActor<TChildrenMap, TActors>, ToParameterizedObject<TActions>, ToParameterizedObject<TGuards>, TDelay, ToStateValue<TConfig>, TTag, TInput, TOutput, TEmitted, TMeta, TConfig>;
};
export {};
