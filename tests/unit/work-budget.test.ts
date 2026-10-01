import { expect, it } from "vitest";
import { WorkBudget } from "../../apps/web/src/server/work-budget";

it("rejects excess concurrent work immediately and releases capacity after success or failure", async () => {
  const budget = new WorkBudget(1);
  let release!: () => void;
  const pending = budget.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );

  await expect(budget.run(async () => "excess")).rejects.toMatchObject({
    status: 429,
  });
  release();
  await pending;
  await expect(
    budget.run(async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  await expect(budget.run(async () => "available")).resolves.toBe("available");
});
