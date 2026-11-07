import { configure } from "@testing-library/dom";

// findBy* / waitFor default to 1 s, which a loaded CI runner can exceed while a
// page renders and its mocked fetches resolve; 3 s keeps slow runs from failing.
configure({ asyncUtilTimeout: 3000 });
