import { verifyAccessToken } from "../utils/jwt.js";

export function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[process.env.COOKIE_NAME];

    if (!token) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const decoded = verifyAccessToken(token);
    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
