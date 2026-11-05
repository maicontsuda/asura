/**
 * API do Asura — para hospedagem com Node (Render/Railway/Fly).
 *
 * Endpoints públicos:
 *   GET  /api/shop                -> catálogo + como pagar
 *   GET  /api/eth-quote           -> cotação ETH em USDC
 *   POST /api/order               -> cria pedido (USDC Base | ETH Base | ETH mainnet)
 *   POST /api/order/:id/verify    -> verifica recibo on-chain e marca pago
 *   GET  /api/orders              -> lista pedidos
 *   GET  /api/order/:id           -> status de um pedido
 *   GET  /pedidos/:id/            -> entregável publicado
 *   GET  /api/health              -> healthcheck
 *
 * Endpoint privado (o agente entrega o resultado):
 *   POST /api/agent/deliver       header x-agent-secret: <AGENT_SECRET>
 *        body { id, html }        -> grava data/pedidos/<id>/index.html
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const viem = await import("viem");
const { base, mainnet } = await import("viem/chains");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const PEDIDOS = path.join(DATA, "pedidos");
const ORDERS_FILE = path.join(DATA, "orders.json");
const PORT = Number(process.env.PORT || 8100);
const AGENT_SECRET = process.env.AGENT_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

const AGENT_WALLET = "0x3ecdD82B0abd76b4B32211d08eE309973760DF6F";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453;

fs.mkdirSync(PEDIDOS, { recursive: true });

const baseClient = viem.createPublicClient({ chain: base, transport: viem.http("https://mainnet.base.org") });
const mainnetClient = viem.createPublicClient({ chain: mainnet, transport: viem.http("https://ethereum.publicnode.com") });

const SERVICES = [
  { id: "landing-page", name: "Página de apresentação (landing page)", priceUsdc: 2, deliverable: "1 página HTML em português, responsiva, sem dependências", eta: "até 24 h" },
  { id: "texto-sobre", name: "Texto de apresentação / sobre", priceUsdc: 1, deliverable: "300–500 palavras em português, tom profissional", eta: "até 12 h" },
  { id: "revisao-texto", name: "Revisão de texto em português", priceUsdc: 1, deliverable: "texto revisado (até 1.000 palavras) + lista de correções", eta: "até 12 h" },
  { id: "ideias-post", name: "5 ideias de conteúdo para redes", priceUsdc: 0.5, deliverable: "5 ideias com gancho, formato e chamada para ação", eta: "até 6 h" },
];

// ── persistência simples (JSON). Em hospedagem com disco efêmero, os pedidos
//    podem ser perdidos no restart; para produção troque por Postgres/SQLite
//    gerenciado. O código já está isolado nessas 2 funções. ──────────────
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8")); } catch { return { orders: [] }; }
}
function saveOrders(d) {
  fs.mkdirSync(path.dirname(ORDERS_FILE), { recursive: true });
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(d, null, 2));
}

// ── cotação ETH ───────────────────────────────────────────────
let ethPriceCache = { at: 0, usd: 2400 };
async function getEthUsd() {
  if (Date.now() - ethPriceCache.at < 5 * 60 * 1000) return ethPriceCache.usd;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j?.ethereum?.usd) ethPriceCache = { at: Date.now(), usd: j.ethereum.usd };
  } catch {}
  return ethPriceCache.usd;
}
const quoteEth = (priceUsdc, ethUsd, margin = 1.02) => viem.parseEther(((priceUsdc / ethUsd) * margin).toFixed(8));

function withDelivery(order) {
  const file = path.join(PEDIDOS, order.id, "index.html");
  const delivered = fs.existsSync(file);
  return {
    id: order.id, serviceId: order.serviceId, serviceName: order.serviceName,
    priceUsdc: order.priceUsdc, status: delivered ? "delivered" : order.status,
    payWith: order.payWith || "USDC", payAmountWei: order.payAmountWei,
    createdAt: order.createdAt, paidAt: order.paidAt, delivered,
    deliveryUrl: delivered ? `${PUBLIC_BASE_URL}/pedidos/${order.id}/` : null,
  };
}

async function verifyUsdc(txHash, order) {
  const receipt = await baseClient.getTransactionReceipt({ hash: txHash });
  if (!receipt || receipt.status !== "success") return { ok: false, error: "transação não confirmada ou falhou" };
  const topic = viem.keccak256(viem.toBytes("Transfer(address,address,uint256)"));
  const expected = BigInt(Math.round(order.priceUsdc * 1e6));
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_BASE.toLowerCase()) continue;
    if (log.topics[0] !== topic || log.topics.length < 3) continue;
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    if (to !== AGENT_WALLET.toLowerCase()) continue;
    if (BigInt(log.data) >= expected) return { ok: true, valueMicro: BigInt(log.data).toString() };
  }
  return { ok: false, error: "não encontrei transferência USDC para a carteira do Asura neste tx" };
}

async function verifyNative(client, txHash, order, rede) {
  let tx, receipt;
  try {
    [tx, receipt] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]);
  } catch { return { ok: false, error: `transação não encontrada na ${rede}` }; }
  if (!receipt || receipt.status !== "success") return { ok: false, error: `transação não confirmada ou falhou na ${rede}` };
  if (!tx?.to || tx.to.toLowerCase() !== AGENT_WALLET.toLowerCase()) return { ok: false, error: "destinatário não é a carteira do Asura" };
  const minWei = BigInt(order.payAmountWei || "0");
  if (tx.value < minWei) return { ok: false, error: `valor insuficiente: ${viem.formatEther(tx.value)} ETH < ${viem.formatEther(minWei)} ETH` };
  return { ok: true, valueWei: tx.value.toString() };
}

async function verifyPayment(txHash, order) {
  const pw = order.payWith || "USDC";
  if (pw === "ETH") return verifyNative(mainnetClient, txHash, order, "Ethereum mainnet");
  if (pw === "ETH_BASE") return verifyNative(baseClient, txHash, order, "rede Base");
  return verifyUsdc(txHash, order);
}

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let d = "";
  req.on("data", (c) => (d += c));
  req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,x-agent-secret" });
      return res.end();
    }

    if (urlPath === "/api/health") return sendJson(res, 200, { ok: true, agent: "Asura", uptime: process.uptime() });

    if (urlPath === "/api/shop") {
      return sendJson(res, 200, {
        agent: "Asura", agentId: 1149100, network: "Base (eip155:8453)", wallet: AGENT_WALLET,
        currency: "USDC", usdcContract: USDC_BASE, services: SERVICES,
        payWith: ["USDC", "ETH_BASE", "ETH"],
        howToPay: ["Crie o pedido em POST /api/order", "Pague em USDC (Base), ETH (Base) ou ETH (mainnet)", "Confirme em POST /api/order/<id>/verify com { txHash }", "O entregável aparece em /pedidos/<id>/"],
      });
    }

    if (urlPath === "/api/eth-quote") {
      const ethUsd = await getEthUsd();
      return sendJson(res, 200, {
        ethUsd,
        quotes: SERVICES.map((s) => ({ serviceId: s.id, priceUsdc: s.priceUsdc, ethUsd, payAmountEth: viem.formatEther(quoteEth(s.priceUsdc, ethUsd)), payAmountWei: quoteEth(s.priceUsdc, ethUsd).toString() })),
      });
    }

    if (urlPath === "/api/order" && req.method === "POST") {
      const body = await readBody(req);
      const svc = SERVICES.find((s) => s.id === body.service);
      if (!svc) return sendJson(res, 400, { ok: false, error: "serviço inválido", services: SERVICES.map((s) => s.id) });
      const payWith = String(body.payWith || "USDC").toUpperCase();
      if (!["USDC", "ETH", "ETH_BASE"].includes(payWith)) return sendJson(res, 400, { ok: false, error: "payWith inválido" });
      const isEth = payWith !== "USDC";
      const ethUsd = isEth ? await getEthUsd() : null;
      const payAmountWei = isEth ? quoteEth(svc.priceUsdc, ethUsd).toString() : null;
      const data = loadOrders();
      const order = {
        id: randomUUID().slice(0, 8), serviceId: svc.id, serviceName: svc.name,
        priceUsdc: svc.priceUsdc, payWith, payAmountWei, ethUsdAtQuote: ethUsd,
        quotedAt: new Date().toISOString(), brief: String(body.brief || "").slice(0, 2000),
        contact: String(body.contact || "").slice(0, 200), status: "awaiting_payment",
        createdAt: new Date().toISOString(), payTo: AGENT_WALLET, chainId: payWith === "ETH" ? 1 : CHAIN_ID,
      };
      data.orders.push(order);
      saveOrders(data);
      const instr = isEth
        ? `Envie ${viem.formatEther(payAmountWei)} ETH na rede ${payWith === "ETH_BASE" ? "Base" : "Ethereum mainnet"} para ${AGENT_WALLET} e chame /api/order/${order.id}/verify com o txHash.`
        : `Envie ${svc.priceUsdc} USDC (Base) para ${AGENT_WALLET} e chame /api/order/${order.id}/verify com o txHash.`;
      return sendJson(res, 200, { ok: true, order: withDelivery(order), instructions: instr });
    }

    const verifyMatch = urlPath.match(/^\/api\/order\/([^/]+)\/verify$/);
    if (verifyMatch && req.method === "POST") {
      const id = verifyMatch[1];
      const body = await readBody(req);
      const data = loadOrders();
      const order = data.orders.find((o) => o.id === id);
      if (!order) return sendJson(res, 404, { ok: false, error: "pedido não encontrado" });
      if (order.status !== "awaiting_payment") return sendJson(res, 200, { ok: true, order: withDelivery(order), note: "pedido já estava " + order.status });
      if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash || "")) return sendJson(res, 400, { ok: false, error: "txHash inválido" });
      if (data.orders.some((o) => o.txHashUsed && o.txHashUsed.toLowerCase() === String(body.txHash).toLowerCase()))
        return sendJson(res, 400, { ok: false, error: "esse txHash já foi usado em outro pedido" });
      try {
        const v = await verifyPayment(body.txHash, order);
        if (!v.ok) return sendJson(res, 400, { ok: false, error: v.error });
        order.status = "paid";
        order.paidAt = new Date().toISOString();
        order.txHashUsed = body.txHash;
        saveOrders(data);
        return sendJson(res, 200, { ok: true, order: withDelivery(order), next: "entrega em /pedidos/" + id });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "falha ao verificar: " + e.message });
      }
    }

    // entrega feita pelo agente (PC do criador) — protegida por segredo
    if (urlPath === "/api/agent/deliver" && req.method === "POST") {
      if (!AGENT_SECRET || req.headers["x-agent-secret"] !== AGENT_SECRET) return sendJson(res, 401, { ok: false, error: "não autorizado" });
      const body = await readBody(req);
      const data = loadOrders();
      const order = data.orders.find((o) => o.id === body.id);
      if (!order) return sendJson(res, 404, { ok: false, error: "pedido não encontrado" });
      if (order.status !== "paid" && order.status !== "delivered")
        return sendJson(res, 400, { ok: false, error: "pedido ainda não está pago (status: " + order.status + ")" });
      const html = String(body.html || "");
      if (html.length < 200) return sendJson(res, 400, { ok: false, error: "html muito curto" });
      fs.mkdirSync(path.join(PEDIDOS, order.id), { recursive: true });
      fs.writeFileSync(path.join(PEDIDOS, order.id, "index.html"), html);
      const out = withDelivery(order);
      return sendJson(res, 200, { ok: true, order: out });
    }

    if (urlPath === "/api/orders") return sendJson(res, 200, { orders: loadOrders().orders.map(withDelivery) });

    const one = urlPath.match(/^\/api\/order\/([^/]+)$/);
    if (one) {
      const order = loadOrders().orders.find((o) => o.id === one[1]);
      if (!order) return sendJson(res, 404, { ok: false, error: "pedido não encontrado" });
      return sendJson(res, 200, { order: withDelivery(order) });
    }

    const delivery = urlPath.match(/^\/pedidos\/([^/]+)\/?$/);
    if (delivery) {
      const file = path.join(PEDIDOS, delivery[1], "index.html");
      if (!fs.existsSync(file)) return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("entrega ainda não publicada");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(file));
    }

    if (urlPath === "/") return sendJson(res, 200, { service: "Asura API", shop: "/api/shop", health: "/api/health" });
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, "0.0.0.0", () => console.log(`[asura-api] porta ${PORT} | wallet ${AGENT_WALLET}`));

