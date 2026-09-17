export const ENVIRONMENT_LABELS = {
  production: "Production",
  staging: "Preview / staging",
  development: "Development",
} as const;

export const SOURCE_MAP_STATES = {
  ready: {
    label: "Ready",
    caption: "Matching private artifacts available",
    tone: "ready",
  },
  pending: {
    label: "Processing",
    caption: "Waiting for artifact validation",
    tone: "pending",
  },
  failed: {
    label: "Upload failed",
    caption: "Rebuild and upload valid source maps",
    tone: "failed",
  },
  missing: {
    label: "Not uploaded",
    caption: "Stack traces show compiled locations",
    tone: "missing",
  },
} as const;

export function sourceMapStatus(state: string) {
  return (
    SOURCE_MAP_STATES[state as keyof typeof SOURCE_MAP_STATES] ??
    SOURCE_MAP_STATES.missing
  );
}

export function reviewLabel(key: string) {
  const match = /^gitlab:[1-9][0-9]{0,9}:([1-9][0-9]{0,9})$/.exec(key);

  return match ? `MR !${match[1]}` : undefined;
}

export type DeploymentSummary = {
  environment: string;
  reviewKey: string;
  registeredAt: Date | null;
};

export function releaseEnvironments(deployments: DeploymentSummary[]) {
  return Object.entries(ENVIRONMENT_LABELS).filter(([key]) =>
    deployments.some((item) => item.environment === key),
  );
}

export function releaseReviews(deployments: DeploymentSummary[]) {
  return [...new Set(deployments.map((item) => item.reviewKey))].filter((key) =>
    reviewLabel(key),
  );
}
