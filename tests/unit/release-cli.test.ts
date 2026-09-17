import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { registerRelease } from "../../packages/cli/src/releases";

const value = {
  release: `account@${"a".repeat(40)}`,
  deployment: {
    environment: "staging",
    review: { provider: "gitlab", repositoryId: 12, number: 34 },
  },
};

it("registers a release without maps using scoped HTTPS authentication and rejects untrusted metadata locally", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ id: randomUUID() }));
  const token = randomBytes(32).toString("hex");
  const project = randomUUID();

  await registerRelease(
    "https://monitor.example.test",
    project,
    token,
    value,
    transport,
  );
  expect(transport).toHaveBeenCalledWith(
    `https://monitor.example.test/api/v1/projects/${project}/releases`,
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      body: JSON.stringify(value),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }),
  );
  transport.mockClear();

  for (const address of [
    "http://monitor.example.test",
    "https://monitor.example.test/redirect",
    "https://user:password@monitor.example.test",
  ]) {
    await expect(
      registerRelease(address, project, token, value, transport),
    ).rejects.toThrow();
  }

  await expect(
    registerRelease(
      "https://monitor.example.test",
      project,
      token,
      {
        ...value,
        deployment: { ...value.deployment, environment: "production" },
      },
      transport,
    ),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
