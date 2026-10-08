export const DependencyStatus = { UP: 'up', DOWN: 'down' } as const;
export type DependencyStatus = (typeof DependencyStatus)[keyof typeof DependencyStatus];

export const Dependency = { POSTGRES: 'postgres', REDIS: 'redis', RABBITMQ: 'rabbitmq' } as const;
export type Dependency = (typeof Dependency)[keyof typeof Dependency];
