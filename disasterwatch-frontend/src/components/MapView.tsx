import type { FC } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { eventRelativeTime, eventTitle } from "../utils/eventText";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Marker,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import {
  buildClusterIndex,
  clusterLeaves,
  clusterRadius,
  clusterTooltip,
  expansionZoom,
  getClustersInView,
  clusterBackground,
  spiderPositions,
  zoomToReveal,
  type ClusterFeature,
  type ClusterPoint,
  type ClusterProps,
  type PointFeature,
} from "../utils/clustering";

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
 * Marker rendering, clustering and flyTo logic inside the map.
 *
 * Nearby events are grouped by a supercluster index (src/utils/clustering.ts)
 * that is re-queried on every zoom/pan with the visible bounds, so only what
 * is on screen is rendered. A cluster is a numbered circle coloured by its
 * highest severity; clicking it zooms to its bounds, or fans its events out
 * (spiderfy) when they cannot be separated at the map's maximum zoom. The
 * highlighted event is never part of the index: it is always drawn on its
 * own, on top, so a selection can never vanish inside a cluster.
 */
const MapInner: FC<MapInnerProps> = ({ disasters, highlightId, onSelect }) => {
  const map = useMap();
  const maxZoom = Number.isFinite(map.getMaxZoom()) ? map.getMaxZoom() : 10;

  // ---- viewport state (drives re-clustering) ----
  const [view, setView] = useState(() => ({ zoom: map.getZoom(), bounds: map.getBounds() }));
  const [spider, setSpider] = useState<{ clusterId: number; center: L.LatLng; leaves: PointFeature[] } | null>(null);
  useMapEvents({
    moveend: () => setView({ zoom: map.getZoom(), bounds: map.getBounds() }),
    zoomend: () => setSpider(null),
    movestart: () => setSpider(null),
  });

  const byId = useMemo(() => new Map(disasters.map((d) => [d.id, d])), [disasters]);
  const clusterPoints = useMemo<ClusterPoint[]>(
    () => disasters.map((d) => ({ id: d.id, type: d.type, severity: d.severity, lat: d.lat, lng: d.lng })),
    [disasters]
  );
  // index for rendering: everything except the highlighted event
  const viewIndex = useMemo(() => buildClusterIndex(clusterPoints.filter((p) => p.id !== highlightId), { maxZoom }), [clusterPoints, highlightId, maxZoom]);
  // index with every event: used to decide how far to zoom to reveal a selection
  const fullIndex = useMemo(() => buildClusterIndex(clusterPoints, { maxZoom }), [clusterPoints, maxZoom]);
  useEffect(() => setSpider(null), [disasters]);

  const features = useMemo(() => {
    const b = view.bounds.pad(0.2);
    const bbox: [number, number, number, number] = [
      Math.max(-180, b.getWest()),
      Math.max(-85, b.getSouth()),
      Math.min(180, b.getEast()),
      Math.min(85, b.getNorth()),
    ];
    return getClustersInView(viewIndex, bbox, view.zoom);
  }, [viewIndex, view]);

  // ---- cluster interaction ----
  const openCluster = (f: ClusterFeature) => {
    const leaves = clusterLeaves(viewIndex, f.clusterId);
    const z = expansionZoom(viewIndex, f.clusterId, maxZoom);
    if (z === null) {
      // cannot be separated by zooming: fan the events out around the cluster
      setSpider({ clusterId: f.clusterId, center: L.latLng(f.lat, f.lng), leaves });
      return;
    }
    const bounds = L.latLngBounds(leaves.map((l) => [l.lat, l.lng] as [number, number]));
    const fit = map.getBoundsZoom(bounds, false, L.point(60, 60));
    const target = Math.min(maxZoom, Math.max(z, fit));
    map.flyTo(bounds.getCenter(), target, { duration: 0.6 });
  };

  const iconCache = useRef(new Map<string, L.DivIcon>());
  // Coloured by event TYPE: one solid marker colour, or a ring split
  // proportionally to the type counts (conic-gradient) with the count on a
  // dark disc in the centre so the number stays readable on every colour.
  const clusterIcon = (count: number, props: ClusterProps) => {
    const r = clusterRadius(count);
    const background = clusterBackground(props);
    const key = `${background}-${r}-${count}`;
    let icon = iconCache.current.get(key);
    if (!icon) {
      const d = r * 2;
      icon = L.divIcon({
        html: `<div class="map-cluster" style="width:${d}px;height:${d}px;background:${background}"><span class="map-cluster-count">${count}</span></div>`,
        className: "map-cluster-icon",
        iconSize: [d, d],
        iconAnchor: [r, r],
      });
      iconCache.current.set(key, icon);
    }
    return icon;
  };

  // Fly to a disaster when it is selected in the list (or deep-linked from
  // the news panel). The target zoom is the smallest zoom at which the event
  // is not inside a cluster (at least 4.5, at most the map's max zoom); when
  // it shares its coordinates with other events the flight ends at max zoom
  // and the co-located cluster is spiderfied so the siblings stay visible.
  //
  // A container resize during the flight cancels it: the size sync below may
  // call setZoom while the flight dips below the minimum zoom, which happens
  // right after mount (the feed column settles) when the selection comes
  // from a cached feed. So a flight requested within the first second after
  // mount waits a few frames. The resize listener lives only while a flight
  // is pending or running: it is removed at the flight's moveend (or 2 s
  // after take-off at the latest), otherwise a later manual pan followed by
  // a window resize would snap the map back to the event.
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (!highlightId) return;
    const target = disasters.find((d) => d.id === highlightId);
    if (!target) return;

    const reveal = zoomToReveal(fullIndex, { id: target.id, lat: target.lat, lng: target.lng }, 4.5, maxZoom);
    const targetZoom = reveal === null ? maxZoom : Math.max(4.5, reveal);

    let timer: number | null = null;
    let armed = false; // resize listener attached
    let guard: number | null = null; // hard stop for the listener
    const disarm = () => {
      if (!armed) return;
      armed = false;
      map.off("resize", onResize);
      map.off("moveend", disarm);
      if (guard !== null) window.clearTimeout(guard);
      guard = null;
    };
    const fly = () => {
      timer = null;
      map.flyTo([target.lat, target.lng], targetZoom, { duration: 0.7 });
      map.once("moveend", disarm);
      if (reveal === null) {
        // co-located events: open the cluster that holds the siblings once the flight has landed
        map.once("moveend", () => {
          const eps = 1e-6;
          const around = getClustersInView(viewIndex, [target.lng - eps, target.lat - eps, target.lng + eps, target.lat + eps], maxZoom);
          const cluster = around.find((f): f is ClusterFeature => f.kind === "cluster");
          if (cluster) setSpider({ clusterId: cluster.clusterId, center: L.latLng(cluster.lat, cluster.lng), leaves: clusterLeaves(viewIndex, cluster.clusterId) });
        });
      }
      if (guard !== null) window.clearTimeout(guard);
      guard = window.setTimeout(disarm, 2000);
    };
    const schedule = (delay: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(fly, delay);
    };
    function onResize() {
      schedule(80);
    }

    armed = true;
    map.on("resize", onResize);
    schedule(Date.now() - mountedAt.current < 1000 ? 120 : 0);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      disarm();
    };
    // viewIndex is only read inside the post-flight callback; re-running the flight on its changes is not wanted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, disasters, map, fullIndex, maxZoom]);

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

  // ---- rendering ----
  const renderPoint = (d: MapDisaster, position: [number, number], isHighlight: boolean, extraKey = "") => {
    const radius = getRadiusBySeverity(d.severity) + (isHighlight ? 3 : 0);
    const markerClass =
      "map-marker map-marker-" + d.type + " map-marker-" + d.severity + (isHighlight ? " map-marker-highlight" : "");
    return (
      <CircleMarker
        key={`${d.id}${extraKey}`}
        center={position}
        radius={radius}
        className={markerClass}
        pathOptions={{
          color: "#F6E8D9",
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
              {d.type === "earthquake" && d.details?.magnitudeLabel && <> · M {d.details.magnitudeLabel}</>}
            </div>
            <div className="dw-tooltip-hint">Click for details</div>
          </div>
        </Tooltip>
      </CircleMarker>
    );
  };

  const highlighted = highlightId ? byId.get(highlightId) : undefined;
  const spiderLayout = spider
    ? (() => {
        const centerPx = map.latLngToContainerPoint(spider.center);
        const positions = spiderPositions(spider.leaves.length, { x: centerPx.x, y: centerPx.y });
        return spider.leaves.map((leaf, i) => ({ leaf, at: map.containerPointToLatLng(L.point(positions[i].x, positions[i].y)) }));
      })()
    : [];

  return (
    <>
      {features.map((f) => {
        if (f.kind === "point") {
          const d = byId.get(f.pointId);
          return d ? renderPoint(d, [d.lat, d.lng], false) : null;
        }
        if (spider && spider.clusterId === f.clusterId) return null; // replaced by the spider below
        return (
          <Marker
            key={`c${f.clusterId}`}
            position={[f.lat, f.lng]}
            icon={clusterIcon(f.count, f.props)}
            keyboard={false}
            eventHandlers={{ click: () => openCluster(f) }}
          >
            <Tooltip direction="top" offset={[0, -clusterRadius(f.count)]} opacity={1} className="dw-tooltip">
              <div className="dw-tooltip-inner">
                <div className="dw-tooltip-title">{clusterTooltip(f.count, f.props)}</div>
                <div className="dw-tooltip-hint">{expansionZoom(viewIndex, f.clusterId, maxZoom) === null ? "Click to fan out" : "Click to zoom in"}</div>
              </div>
            </Tooltip>
          </Marker>
        );
      })}

      {spiderLayout.map(({ leaf, at }) => {
        const d = byId.get(leaf.pointId);
        if (!d) return null;
        return (
          <Fragment key={`s${leaf.pointId}`}>
            <Polyline positions={[spider!.center, at]} pathOptions={{ color: "#F6E8D9", weight: 1, opacity: 0.6, dashArray: "3 3" }} interactive={false} />
            {renderPoint(d, [at.lat, at.lng], false, "-spider")}
          </Fragment>
        );
      })}

      {/* the selected event is always rendered on its own, last, so it sits on top of everything */}
      {highlighted && renderPoint(highlighted, [highlighted.lat, highlighted.lng], true)}
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
