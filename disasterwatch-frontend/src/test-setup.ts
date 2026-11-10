import { afterEach } from "vitest";
import { configure } from "@testing-library/dom";

// The dashboard keeps the last live feed in localStorage (services/feedSnapshot.ts); without
// this, one test's feed would be the next test's starting point.
afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* environments without storage */
  }
});

// findBy* / waitFor default to 1 s, which a loaded CI runner can exceed while a
// page renders and its mocked fetches resolve; 3 s keeps slow runs from failing.
configure({ asyncUtilTimeout: 3000 });
