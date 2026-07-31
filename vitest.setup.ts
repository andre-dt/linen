// Setup for the `dom` test project: registers the jest-dom matchers
// (toBeInTheDocument, toHaveAttribute, …) against vitest's expect, so
// component tests read against the rendered DOM the way the reference
// project's do.
import "@testing-library/jest-dom/vitest"
