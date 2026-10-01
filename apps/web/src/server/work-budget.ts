import { AuthError } from "./auth-error";

/** Reject excess expensive work instead of retaining an unbounded request queue. */
export class WorkBudget {
  private active = 0;

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      throw new AuthError(429);
    }

    this.active++;

    try {
      return await operation();
    } finally {
      this.active--;
    }
  }
}
