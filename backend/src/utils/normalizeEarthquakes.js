export function normalizeUsgsEarthquakes(events) {
  return events.map((e, index) => {
    const props = e.properties;
    const coords = e.geometry?.coordinates || [];

    return {
      id: 100000 + index, // NASA ile çakışmasın
      type: "earthquake",
      location: props.place || "Unknown location",
      meta: `Mag ${props.mag ?? "?"} • ${new Date(props.time).toUTCString()}`,
      severity:
        props.mag >= 6
          ? "high"
          : props.mag >= 4.5
          ? "medium"
          : "low",
      timeMinutesAgo: Math.floor(
        (Date.now() - props.time) / 60000
      ),
      description:
        props.title ||
        "Earthquake event reported by USGS.",
      lat: coords[1],
      lng: coords[0],
    };
  });
}
