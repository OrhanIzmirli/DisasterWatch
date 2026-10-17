// Entry of the lazily loaded map chunk: Leaflet, its stylesheet, supercluster and MapView
// load only when a map is actually shown (on a phone in the Feed view they never do).
import "leaflet/dist/leaflet.css";

export { default } from "./MapView";
