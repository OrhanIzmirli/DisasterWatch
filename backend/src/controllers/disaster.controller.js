// backend/src/controllers/disaster.controller.js
import { getAllDisasters } from "../services/disaster.service.js";

export function getDisasters(req, res) {
  const data = getAllDisasters();

  res.json(data);
}
