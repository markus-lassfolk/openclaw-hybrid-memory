---
layout: default
title: Azure Foundry and OpenClaw
parent: Configuration
nav_order: 5
---
# Azure / Microsoft Foundry och OpenClaw (två lager)

Ja — i praktiken behöver du tänka på **två ställen**, men de har **olika roller**:

## 1. OpenClaw-gateway (”vanliga” inställningarna)

**Syfte:** Agentens chatt, `agents.defaults.model`, modellistan som gatewayen känner till, OAuth-routing via gateway, m.m.

Historiskt ligger modellkatalogen i **`openclaw.json` under `models.providers`** (se t.ex. [Microsoft Tech Community: Integrating Microsoft Foundry with OpenClaw](https://techcommunity.microsoft.com/blog/educatordeveloperblog/integrating-microsoft-foundry-with-openclaw-step-by-step-model-configuration/4495586)). Där anger du:

- `baseUrl` mot Azure OpenAI v1-kompatibel endpoint  
- `apiKey`  
- För vissa Azure-uppsättningar: **`authHeader`: false** och **`headers`: `{ "api-key": "<samma nyckel>" }`** (Azure använder ofta `api-key`-headern i stället för `Authorization: Bearer`) — exakt som i artikeln.

**Obs:** Vissa OpenClaw-versioner (t.ex. 2026.3.x CLI) kan **strikt validera** `openclaw.json` och **visa fel på top-level `models`**. Då kan du inte lägga hela Foundry-katalogen där utan att antingen uppgradera OpenClaw, köra `openclaw doctor`, eller följa den modell som gäller för just din version. Hybrid-memory kan fortfarande fungera via plugin-konfiguration nedan.

## 2. Hybrid Memory-plugin (`plugins.entries["openclaw-hybrid-memory"].config`)

**Syfte:** Minne, cron, distill, verify, `hybrid-mem`-kommandon, m.m.

Här konfigurerar du **`llm.nano` / `llm.default` / `llm.heavy`** och **`llm.providers`** med modell-ID:n som `azure-foundry/...`, `azure-foundry-responses/...`, osv., samt nycklar (gärna `env:AZURE_OPENAI_API_KEY`, `env:OPENAI_API_KEY`).

Vid uppstart **slår plugin ihop** gatewayens provider-konfiguration med pluginens `llm.providers` (se `initializeDatabases` i `setup/init-databases.ts`):

- Den läser gatewayens **`models.providers`**, eller **`llm.providers`** på gateway-konfigurationen, eller top-level **`providers`**, och fyller i saknade nycklar/baseURL i pluginens `llm.providers`.

Om top-level **`models` saknas** i `openclaw.json` (t.ex. p.g.a. schema) **försvinner den vägen** — då är det **extra viktigt** att hybrid-memory har **kompletta `llm.providers`** (baseURL + `env:...`-nycklar) för Azure Foundry.

Mer bakgrund: [LLM-AND-PROVIDERS.md](LLM-AND-PROVIDERS.md) (Gateway merge, tiers).

## Sammanfattning

| Var | Vad |
|-----|-----|
| **Gateway / `models.providers`** (om din OpenClaw-version tillåter det) | Agentens huvudmodeller, samma mönster som i [Microsoft-artikeln](https://techcommunity.microsoft.com/blog/educatordeveloperblog/integrating-microsoft-foundry-with-openclaw-step-by-step-model-configuration/4495586) (inkl. `api-key`-header om det behövs). |
| **Hybrid-memory `llm` + `.env`** | Allt plugin-relaterat; **måste** vara korrekt om gateway inte längre exponerar `models.providers`. |

**Provider-namn:** Artikeln använder t.ex. **`azure-openai-responses`**. Din deployment kan använda **`azure-foundry`** / **`azure-foundry-responses`** — viktigt är att **modell-ID** (t.ex. `azure-foundry/gpt-5.4`) matchar en provider som finns i `llm.providers` och att **`AZURE_OPENAI_API_KEY`** (och vid behov base URL) stämmer mot din Foundry-/Azure-resurs.

**Saknas Anthropic i `openclaw models`?** Det kommandot visar bara modeller gatewayen **registrerat** (nyckel/OAuth + katalog). Anthropic måste konfigureras för gatewayen (t.ex. `openclaw configure`), inte bara i hybrid-memory eller `.env`. Se [DORIS-OPENCLAW-MODELS.md](../deploy/DORIS-OPENCLAW-MODELS.md) (avsnitt om Anthropic).

## Nycklar

- **`OPENAI_API_KEY`** — OpenAI (api.openai.com), inte samma som Azure.
- **`AZURE_OPENAI_API_KEY`** — Azure OpenAI / Foundry (se [init-databases resolveProviderApiKey](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/extensions/memory-hybrid/setup/init-databases.ts) för `azure-foundry` / `azure-foundry-responses`).

Om något fortfarande fallerar: kör `openclaw hybrid-mem verify --test-llm` och kontrollera att Azure-raderna får **Success** eller förväntad skip (t.ex. Responses-only).
