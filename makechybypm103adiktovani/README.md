# Chybové běhy Make — DIKTOVANI, PM103, ADRESY & MEDISTAR

Webová aplikace na Netlify (projekt `makechybypm103adiktovani`), která hlídá vybrané scénáře Make:
ukáže, zda scénář **jede** (je zapnutý a poslední běh dopadl dobře), co čeká na opakované spuštění
(neúplné běhy / DLQ), jaké chybové běhy má v historii, a umožní je z prohlížeče znovu spustit.

**Web:** https://makechybypm103adiktovani.netlify.app

## Sledované scénáře

Seznam je v `netlify/functions/scenarios.mjs`:

| ID scénáře | Scénář |
|-----------:|--------|
| 5082766 | 1. DIKTOVANI AI vyšetření MSPP – JOTFORM |
| 6231864 | 2. PM103 JOTFORM |
| 7734429 | B1. Načtení ADRES po importu z Excelu a úprava adres – AKTUÁLNÍ SCÉNÁŘ (diakritika atd.) |
| 7734406 | A. MEDISTAR – Načtení dat po importu z Excelu do PacientiVykony a spuštění statistik |

Seznam jde přepsat i bez zásahu do kódu proměnnou prostředí `MAKE_SCENARIOS`
(JSON pole, např. `[{"id":7734429,"name":"B1. Adresy"}]`).

## Co stránka umí

- **Stav scénáře** – zelené *JEDE*, žluté *POZOR* (varování, nic za poslední dny, čeká DLQ) nebo červené *NEJEDE*
  (scénář vypnutý / pozastavený, poslední běh skončil chybou). U vypnutého scénáře je odkaz „zapnout v Make“.
- **Čeká na opakované spuštění** – neúplné běhy (DLQ). „Spustit znovu“ pokračuje od modulu, kde běh spadl,
  takže nehrozí duplicitní zápis už provedených kroků. „Spustit vše“ zopakuje všechny najednou.
- **Chybové běhy v historii** – běhy se stavem chyba/varování za poslední dny (výchozí 3).
  U chybového běhu, jehož vstupní data Make ještě uchovává, je tlačítko **„Spustit znovu z historie“**:
  přehraje celý běh znovu se stejnými vstupními daty (např. stejný importovaný soubor z Excelu).
  Totéž nabízí tlačítko „Spustit znovu poslední běh“ ve stavovém řádku, když scénář nejede a nic nečeká v DLQ.

## Struktura

```
public/                          statické soubory webu (index.html, ikony)
netlify/functions/api.mjs        backend – Netlify Function obsluhující /api/*
netlify/functions/scenarios.mjs  seznam sledovaných scénářů
test/api.test.mjs                testy backendu nad falešným Make API (npm test)
netlify.toml                     nastavení Netlify (publish = public, functions = netlify/functions)
```

### API backendu

| Metoda a cesta | Tělo | Popis |
|---|---|---|
| `GET /api/errors` | – | přehled všech scénářů (stav, DLQ, chybové běhy) |
| `POST /api/retry` | `{"dlqId": "…"}` | opakovat jeden neúplný běh (`POST /dlqs/{id}/retry` v Make) |
| `POST /api/retry-all` | `{"scenarioId": 123}` | opakovat všechny neúplné běhy scénáře (`POST /dlqs/retry?scenarioId=…`) |
| `POST /api/replay` | `{"scenarioId": 123, "executionId": "…"}` | přehrát běh z historie (`POST /scenarios/{id}/replay`) |

## Nastavení v Netlify (proměnné prostředí)

| Proměnná | Význam |
|---|---|
| `MAKE_API_TOKEN` | API token Make (lze i `MAKE_TOKEN` nebo `MAKE_API_KEY`). Token potřebuje oprávnění `scenarios:read`, `scenarios:write`, `dlqs:read`, `dlqs:write`. |
| `MAKE_ZONE` | zóna Make, výchozí `eu2.make.com` |
| `MAKE_TEAM_ID` | ID týmu pro odkazy do Make, výchozí `1179427` |
| `DAYS_BACK` | kolik dní historie zobrazit, výchozí `3` |
| `MAKE_SCENARIOS` | volitelné přepsání seznamu scénářů (viz výše) |
| `APP_PASSWORD` | heslo aplikace. Je-li nastaveno, API vyžaduje HTTP Basic Auth (jméno libovolné, heslo = tato hodnota); prohlížeč nebo stránka se na něj zeptá. Bez nastavení je web volně přístupný. |

## Úpravy a nasazení

Kód lze upravovat přímo zde na GitHubu nebo přes Claude. Web má v Netlify už nastavené proměnné
`MAKE_API_TOKEN` a `APP_PASSWORD`, takže po nasazení nové verze není třeba nic doplňovat.

Nasadit lze dvěma způsoby:

1. **Propojit repozitář s Netlify** (Site configuration → Build & deploy → Link repository, větev `main`).
   Každá změna v `main` se pak nasadí automaticky; build příkaz není potřeba, Netlify vezme `public/`
   a funkci z `netlify/functions/`.
2. **Netlify CLI z počítače** – ve složce projektu spustit:
   ```
   npx netlify-cli login
   npx netlify-cli deploy --prod --site 557722b9-ebdb-4623-bd45-371a14f60d59
   ```
   CLI sbalí funkci i statické soubory a nahraje je jako nový produkční deploy.

Lokální kontrola backendu: `npm test` (nepotřebuje přístup k Make – testy běží nad falešným API).
