import { describe, it, expect } from "vitest";
import { gdacsRefFromSources } from "./gdacsRef";

describe("gdacsRefFromSources", () => {
  it("reads the event reference from a GDACS report link", () => {
    expect(gdacsRefFromSources([{ url: "https://eonet.gsfc.nasa.gov/x" }, { url: "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1033539" }])).toEqual({ eventtype: "WF", eventid: "1033539" });
  });

  it("ignores other hosts, other event types and malformed ids", () => {
    expect(gdacsRefFromSources([{ url: "https://example.com/report.aspx?eventtype=WF&eventid=1" }])).toBeNull();
    expect(gdacsRefFromSources([{ url: "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1" }])).toBeNull();
    expect(gdacsRefFromSources([{ url: "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1x" }])).toBeNull();
    expect(gdacsRefFromSources(undefined)).toBeNull();
  });
});
