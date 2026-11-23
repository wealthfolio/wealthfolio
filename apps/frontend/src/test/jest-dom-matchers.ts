// The empty interface below merges into Vitest's; it is not an empty type.
/* oxlint-disable typescript/no-empty-object-type */
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// jest-dom's own Vitest types augment Vitest 4's one-parameter Assertion, which
// Vitest 5 no longer merges (testing-library/jest-dom#738). Vitest 5 reads custom
// matchers from Matchers<R, T>, so add jest-dom's there. This is a .ts file, not a
// .d.ts, so skipLibCheck can't hide a mismatch.
declare module "vitest" {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<T, R> {}
}
