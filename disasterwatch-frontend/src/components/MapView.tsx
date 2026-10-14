import type { FC } from "react";
import { useEffect } from "react";
import { eventRelativeTime, eventTitle } from "../utils/eventText";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Tooltip,
  useMap,
} from "react-leaflet";

// Web Mercator world tiles are 256px square per zoom step (256 * 2^z).
// Below this helper figures out the smallest integer zoom at which the
// rendered world is at least as big as the map's own container, in both
// dimensions. Anything lower than that and the container is bigger than
// the world image, which is what produces a gray strip along an edge
// (most visible after the map column is stretched to match the feed
// column's height).
const TILE_SIZE = 256;
const WORLD_BOUNDS = L.latLngBounds([-85.05, -180], [85.05, 180]);

function minZoomForContainer(width: number, height: number) {
  const longestSide = Math.max(width, height, 1);
  return Math.max(2, Math.ceil(Math.log2(longestSide / TILE_SIZE)));
}

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
  timeMinutesAgo?: number;
  /** Rich fields from the backend; only what the tooltip needs is read here. */
  details?: {
    cleanTitle?: string;
    occurredAt?: string | null;
    magnitude?: number | null;
    /** Pre-formatted magnitude text ("6.1"), the same string every other surface shows. */
    magnitudeLabel?: string | null;
  };
};

type MapViewProps = {
  disasters: MapDisaster[];
  highlightId?: number | null;
  /** Called with the disaster id when a marker is clicked. */
  onSelect?: (id: number) => void;
};

type MapInnerProps = {
  disasters: MapDisaster[];
  highlightId?: number | null;
  onSelect?: (id: number) => void;
};

const TYPE_LABELS: Record<DisasterType, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

/** Tooltip title: the backend's clean title, else the raw location without a trailing id. */
function tooltipTitle(d: MapDisaster) {
  return eventTitle(d);
}

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
const MapInner: FC<MapInnerProps> = ({ disasters, highlightId, onSelect }) => {
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

  // The map stretches with the feed column, so tell Leaflet when its box
  // changes size, and recompute the minimum zoom that still fully covers
  // the (now taller) container — otherwise the world render can end up
  // shorter than the box and a gray strip shows above/below it.
  useEffect(() => {
    const container = map.getContainer();

    const syncToContainerSize = () => {
      map.invalidateSize();

      const { x: width, y: height } = map.getSize();
      const requiredMinZoom = minZoomForContainer(width, height);

      if (map.getMinZoom() !== requiredMinZoom) {
        map.setMinZoom(requiredMinZoom);
      }
      if (map.getZoom() < requiredMinZoom) {
        map.setZoom(requiredMinZoom);
      }
    };

    syncToContainerSize();

    const observer = new ResizeObserver(syncToContainerSize);
    observer.observe(container);
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
            eventHandlers={{
              click: () => onSelect?.(d.id),
            }}
          >
            {/*
              direction="auto" lets Leaflet flip the tooltip to whichever
              side has room (right half of the map opens left, left half
              opens right), so markers near the map's edges don't get their
              tooltip clipped by the container. Paired with the
              .leaflet-tooltip wrap override in App.css — the Leaflet
              default is `white-space: nowrap`, which is what was pushing
              long location names past the edge in the first place.
            */}
            <Tooltip direction="auto" offset={[0, -4]} opacity={1} className="dw-tooltip">
              <div className="dw-tooltip-inner">
                <div className="dw-tooltip-kicker">
                  <span className={`dw-tooltip-type dw-tooltip-type-${d.type}`}>{TYPE_LABELS[d.type]}</span>
                  <span className={`dw-tooltip-sev dw-tooltip-sev-${d.severity}`}>{d.severity}</span>
                </div>
                <div className="dw-tooltip-title">{tooltipTitle(d)}</div>
                <div className="dw-tooltip-meta">
                  {eventRelativeTime(d) ?? d.meta}
                  {d.type === "earthquake" && d.details?.magnitudeLabel && (
                    <> · M {d.details.magnitudeLabel}</>
                  )}
                </div>
                <div className="dw-tooltip-hint">Click for details</div>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
};

const MapView: FC<MapViewProps> = ({ disasters, highlightId, onSelect }) => {
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
      maxBounds={WORLD_BOUNDS}
      maxBoundsViscosity={1.0}
    >
      {/*
        CARTO's free dark_all raster tiles (basemaps.cartocdn.com) now
        require an API key — anonymous requests return a tile that just
        says "API KEY REQUIRED" instead of a map. That's almost certainly
        why this was on Esri's World_Dark_Gray_Base before. It has no
        retina/@2x tiles (so it looks a bit soft on high-DPI screens at
        world zoom), but it's free and keyless, which the app needs more
        than extra sharpness. Don't swap this for a CARTO raster URL again
        without an API key — it will silently break the whole map.
      */}
      <TileLayer
        attribution='&copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS User Community'
        url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      />

      <MapInner disasters={disasters} highlightId={highlightId} onSelect={onSelect} />
    </MapContainer>
  );
};

export default MapView;
