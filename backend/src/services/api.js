import cors from "cors";

app.use(
  cors({
    origin: "http://localhost:8080", // frontend
    credentials: true,               // 🍪 cookie gönderimine izin
  })
);
