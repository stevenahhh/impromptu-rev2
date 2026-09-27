const r = await fetch("https://embedding-tls:8443/v1/embeddings", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${Bun.env.EMBEDDING_MODEL_API_KEY}`,
  },
  body: JSON.stringify({ model: Bun.env.EMBEDDING_MODEL, input: "task-3 baseline probe" }),
});
const j = await r.json();
console.log("http_status", r.status);
console.log("dims", j?.data?.[0]?.embedding?.length, "model", j?.data?.[0]?.model ?? j?.model);
