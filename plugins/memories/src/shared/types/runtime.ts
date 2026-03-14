export interface RuntimeCheckInput {
  platform?: NodeJS.Platform | undefined;
  arch?: NodeJS.Architecture | undefined;
  nodeVersion?: string | undefined;
}

export interface RuntimeDetails {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  nodeVersion: string;
  nodeMajorVersion: number;
}
