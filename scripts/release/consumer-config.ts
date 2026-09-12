export function registryConsumerConfig(version: string) {
  return {
    nodeLinker: "node-modules",
    enableScripts: false,
    // These exact SDK archives are checked against the release source before installation.
    npmPreapprovedPackages: [
      `@getexception/browser@${version}`,
      `@getexception/react@${version}`,
    ],
  };
}
