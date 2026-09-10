# Scénáře Make — přehled a spouštění

Webová aplikace na Netlify (projekt `makechybypm103adiktovani`). Jedna přehledná tabulka sledovaných scénářů Make:
zda je scénář **aktivní**, jak dopadl **poslední běh**, kolik má **nedoběhlých běhů**, odkaz do **historie v Make**
a tlačítka pro **opětovné spuštění** – vše bez přihlašování.

**Web:** https://makechybypm103adiktovani.netlify.app

> Bez přihlašování znamená, že kdokoli se znalostí adresy může scénáře spouštět. Adresu proto nikde nezveřejňujte.

## Sledované scénáře

Seznam je v `netlify/lib/scenarios.mjs` (pořadí = pořadí řádků v tabulce):

| ID scénáře | Scénář |
|-----------:|--------|
| 5082766 | 1. DIKTOVANI AI vyšetření MSPP – JOTFORM |
| 6231864 | 2. PM103 JOTFORM |
| 7734429 | B1. Načtení ADRES po importu z Excelu a úprava adres – AKTUÁLNÍ SCÉNÁŘ (diakritika atd.) |
| 7734406 | A. MEDISTAR – Načtení dat po importu z Excelu do PacientiVykony a spuštění statistik |
| 4825799 | MEDISTAR-STATISTIKY – kompletní tabulky do Modré hlavy (on-demand, tlačítko „Spustit scénář“) |

Přidání dalšího scénáře: doplnit řádek `{ id: <ID>, name: "<název>" }` (ID je v Make v adrese scénáře).
Seznam jde přepsat i bez zásahu do kódu proměnnou prostředí `MAKE_SCENARIOS`
(JSON pole, např. `[{"id":7734429,"name":"B1. Adresy"}]`).

## Sloupce tabulky

| Sloupec | Co znamená |
|---|---|
| Scénář | název, ID, složka a typ plánování; u problému krátký důvod |
| Aktivní | ANO / NE podle Make; u NE odkaz „zapnout v Make“ |
| Poslední běh | OK / varování / chyba, čas, odkaz na detail běhu v Make |
| Běhy za N dny | počet běhů v období, z toho OK a s chybou (N = `DAYS_BACK`, výchozí 3) |
| Nedoběhlé | počet neúplných běhů (DLQ) a tlačítko **Spustit nedoběhlé** – dokončí je od modulu, kde spadly |
| Historie | odkazy do Make a **▸ historie**, která rozbalí přímo v aplikaci nedoběhlé běhy a posledních 20 běhů (stav, trvání, operace, chyba). U každého běhu: **co se stalo** (detail běhu z Make bez přihlášení), **Spustit znovu**, odkaz do Make. Tlačítko „Načíst starší běhy“ dotáhne až 100 běhů. |
| Spuštění | **Spustit scénář** (on-demand scénář) nebo **Spustit znovu poslední běh** (scénář s webhookem – přehrání se stejnými vstupními daty) |

## Struktura

```
public/                          statické soubory webu (index.html, ikony)
netlify/functions/api.mjs        backend – Netlify Function obsluhující /api/*
netlify/lib/scenarios.mjs  seznam sledovaných scénářů
test/api.test.mjs                testy backendu nad falešným Make API (npm test)
netlify.toml                     nastavení Netlify (publish = public, functions = netlify/functions)
```

### API backendu

| Metoda a cesta | Tělo | Popis |
|---|---|---|
| `GET /api/overview` | – | data pro tabulku včetně posledních 20 běhů každého scénáře |
| `GET /api/history?scenarioId=123&limit=100` | – | historie běhů scénáře (`GET /scenarios/{id}/logs`) |
| `GET /api/execution?scenarioId=123&executionId=…` | – | detail jednoho běhu (`GET /scenarios/{id}/executions/{executionId}`) |
| `POST /api/rerun` | `{"scenarioId": 123}` | on-demand scénář spustí (`POST /scenarios/{id}/run`), jinak přehraje poslední přehratelný běh (`POST /scenarios/{id}/replay`) |
| `POST /api/replay` | `{"scenarioId": 123, "executionId": "…"}` | přehrát konkrétní běh z historie |
| `POST /api/retry` | `{"dlqId": "…"}` | spustit jeden nedoběhlý běh (`POST /dlqs/{id}/retry`) |
| `POST /api/retry-all` | `{"scenarioId": 123}` | spustit všechny nedoběhlé běhy scénáře (`POST /dlqs/retry?scenarioId=…`) |

## Nastavení v Netlify (proměnné prostředí)

| Proměnná | Význam |
|---|---|
| `MAKE_API_TOKEN` | **povinné** – API token Make (lze i `MAKE_TOKEN` / `MAKE_API_KEY`). Potřebuje oprávnění `scenarios:read`, `scenarios:write`, `scenarios:run`, `dlqs:read`, `dlqs:write`. |
| `MAKE_ZONE` | zóna Make, výchozí `eu2.make.com` |
| `MAKE_TEAM_ID` | ID týmu pro odkazy do Make, výchozí `1179427` |
| `DAYS_BACK` | kolik dní historie chyb zobrazit, výchozí `3` |
| `MAKE_SCENARIOS` | volitelné přepsání seznamu scénářů (viz výše) |

Proměnná `APP_PASSWORD` z dřívější verze se už nepoužívá, lze ji smazat.

## Nasazení

1. Nahrát obsah této složky do repozitáře na GitHubu (větev `main`).
2. V Netlify u projektu: Site configuration → Build & deploy → **Link repository**, vybrat repozitář a větev `main`.
   Build command nechat prázdný; publish directory `public` a složku funkcí bere Netlify z `netlify.toml`.
3. Zkontrolovat, že je nastavená proměnná `MAKE_API_TOKEN` (Site configuration → Environment variables).
4. Každá další změna v `main` se nasadí automaticky.

Lokální kontrola backendu: `npm test` (nepotřebuje přístup k Make – testy běží nad falešným API).
