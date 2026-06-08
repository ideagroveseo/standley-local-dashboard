exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode:200, headers, body:"" };
  const key = "2bce57044367b729b511132c9a2a2c614bd4dd5d";
  const { endpoint, method, payload } = JSON.parse(event.body || "{}");
  if (!endpoint) return { statusCode:400, headers, body: JSON.stringify({ error:"No endpoint" }) };
  try {
    const url = "https://api.brightlocal.com" + endpoint;
    console.log(method||"GET", url);
    const res = await fetch(url, {
      method: method || "GET",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: method && method !== "GET" ? JSON.stringify(payload||{}) : undefined,
    });
    const text = await res.text();
    console.log("Response:", text.slice(0, 2000));
    return { statusCode:200, headers, body: text };
  } catch(e) {
    console.error(e.message);
    return { statusCode:500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
