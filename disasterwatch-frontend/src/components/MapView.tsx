import type { FC } from "react";
import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Tooltip,
  useMap,
} from "react-leaflet";

type DisasterType = "earthquake" | "flood" | "wildfire" | "storm";
type Severity = "high" | "medium" | "low";

export type MapDisaster = {
  id: number;
  type: DisasterType;
  severity: Severity;
  location: string;
  lat: number;
  lng: number;
  meta: string;
};

type MapViewProps = {
  disasters: MapDisaster[];
  highlightId?: number | null;
};

type MapInnerProps = {
  disasters: MapDisaster[];
  highlightId?: number | null;
};

const getColorByType = (type: DisasterType) => {
  switch (type) {
    case "earthquake":
      return "#C1121F";
    case "flood":
      return "#3B82F6";
    case "wildfire":
      return "#F97316";
    case "storm":
      return "#9CA3AF";
    default:
      return "#669BBC";
  }
};

const getRadiusBySeverity = (severity: Severity) => {
  switch (severity) {
    case "high":
      return 11;
    case "medium":
      return 8;
    case "low":
      return 6;
    default:
      return 7;
  }
};

/**
 * Marker rendering and flyTo logic inside the map
 */
const MapInner: FC<MapInnerProps> = ({ disasters, highlightId }) => {
  const map = useMap();

  // Fly to a disaster when it is selected in the list
  useEffect(() => {
    if (!highlightId) return;
    const target = disasters.find((d) => d.id === highlightId);
    if (!target) return;

    map.flyTo([target.lat, target.lng], 4.5, {
      duration: 0.7,
    });
  }, [highlightId, disasters, map]);

  // The map stretches with the feed column, so tell Leaflet when its box changes size
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);

  return (
    <>
      {disasters.map((d) => {
        const isHighlight = d.id === highlightId;
        const radius =
          getRadiusBySeverity(d.severity) + (isHighlight ? 3 : 0);

        const markerClass =
          "map-marker map-marker-" +
          d.type +
          " map-marker-" +
          d.severity +
          (isHighlight ? " map-marker-highlight" : "");

        return (
          <CircleMarker
            key={d.id}
            center={[d.lat, d.lng]}
            radius={radius}
            className={markerClass}
            pathOptions={{
              color: isHighlight ? "#F6E8D9" : "#F6E8D9",
              weight: isHighlight ? 2.2 : 1.5,
              fillColor: getColorByType(d.type),
              fillOpacity: isHighlight ? 1 : 0.95,
            }}
          >
            <Tooltip direction="top" offset={[0, -4]} opacity={0.95}>
              <div style={{ maxWidth: 200 }}>
                <strong>{d.location}</strong>
                <br />
                <span style={{ fontSize: "0.75rem" }}>{d.meta}</span>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
};

const MapView: FC<MapViewProps> = ({ disasters, highlightId }) => {
  const center: [number, number] = [30, 10];
  const zoom = 2.3;

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className="map-leaflet-container"
      scrollWheelZoom={true}
      minZoom={2}
      maxZoom={10}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS User Community'
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      />

      <MapInner disasters={disasters} highlightId={highlightId} />
    </MapContainer>
  );
};

export default MapView;
