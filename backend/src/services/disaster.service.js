// backend/src/services/disaster.service.js

const disasters = [
  {
    id: 1,
    type: "earthquake",
    title: "Earthquake in Turkey",
    magnitude: 6.4,
    lat: 38.4,
    lng: 27.1,
    date: "2025-12-10"
  },
  {
    id: 2,
    type: "flood",
    title: "Flood in Germany",
    severity: "high",
    lat: 52.5,
    lng: 13.4,
    date: "2025-12-12"
  }
];

export function getAllDisasters() {
  return disasters;
}
