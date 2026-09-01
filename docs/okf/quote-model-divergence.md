---
type: overview
title: Shell quote models, measured divergence against bash
description: The policy engine has three independent shell-word models plus a raw-regex trigger layer. This records what each actually extracts, measured against real bash, which divergences are fail-open, and the evidence-led ordering for closing them.
tags: [policy-engine, bash-match, quote-model, fail-open, measurement]
timestamp: 2026-09-01T07:08:49Z
sources:
  - src/runtime/command-normalize.ts
  - src/cli/init/composer.ts
  - src/runtime/bash-prefix-parse.ts
  - src/runtime/read-only-bash.ts
  - src/runtime/intercept.ts
  - src/cli/policy/intercept.ts
  - src/runtime/environment-resolver.ts
  - src/cli/init/templates.ts
  - docs/examples/full-manifest.yaml
  - scripts/measure-bash-prefix-parse.mjs
---

# Shell quote models, measured divergence against bash

Task `287fefaf`, gemessen 2026-08-01 gegen master `c423880`, Fassung 2
nach einer skeptischen Gegenprüfung. Alle Zahlen stammen aus gelaufenen
Messungen mit echtem bash als Schiedsrichter über PATH-Shims. Die
Messskripte lagen im Scratchpad des Runs und sind nicht Teil des Repos;
nachvollziehbar ist damit die Gating-Disziplin, nicht der Korpus. Für
den cdTarget-Kanal existiert mit `scripts/measure-bash-prefix-parse.mjs`
ein eingechecktes Instrument mit demselben Pro-Arm-Gate.

## Status seit dieser Messung

Dieses Dokument ist ein Post-Fix-Writeup: es lag bis zum Release bewusst
zurück, weil es kopierfertige Exploits gegen im damals ausgelieferten
0.42.0 offene Gates enthält. **Empfehlung 1 (`&` ins Boundary-Alphabet)
ist auf der Trigger-Ebene umgesetzt und ausgeliefert**, Task `d834a065`,
in v0.43.0 über `src/cli/init/templates.ts`, `src/cli/init/composer.ts`
und `docs/examples/full-manifest.yaml`; ein bestehendes `full`-Install
zieht sie erst nach erneutem `harness init --template full --force`
(Template-Ebene, kein Engine-Upgrade). `d834a065` hat einen ersten
Fehlalarm-Korpus mitgemessen (3 vorbestehende + 6 neue Fehlalarme); die in
Empfehlung 1 offen gelassene Präzisionsseite (K4, 75/75 ungemessen) läuft
als Folge-Task `b150745c`, die gemeinsame `decodeShellWord`-Primitive aus
Empfehlung 2 als `fdee7d0f`. **`76671e5a` ist inzwischen umgesetzt und
ausgeliefert, in v0.44.0:** die drei Policy-Pack-Runtime-Regexe
(`CURATED_MUTATION_BASH_RE`, `GH_PR_MERGE_BASH_RE` in
`src/policy-packs/builtin/post-merge-gate-runtime.ts`,
`DEFAULT_PUSH_BASH_RE` in `src/policy-packs/builtin/solution-acceptance-runtime.ts`)
UND dieses Repos eigener `dogfood/harness.yaml`-`dogfood-recency`-Trigger
erkennen jetzt ebenfalls einzelnes `&` als Boundary (`&&` bleibt
subsumiert, kein Verlust gemessen über einen 49.999-String-Korpus mit
bestandener Positivkontrolle). Bewusst weiterhin NICHT gesweept:
`ESCAPE_GIT_BASH_RE`/`ESCAPE_HARNESS_BASH_RE` (Allow-Listen im selben
Pack, wo Verbreitern eine Gate LOCKERT statt sie zu härten). **Die
benachbarte `command-normalize`-Boundary-Lücke** (`A=x&env -C /tmp git
status`, deren naiver `&`-in-`BOUNDARY_RE`-Fix 140 von 140 gequotete
Wert-Formen regressiert) **ist als `aabbad63` ebenfalls inzwischen
geschlossen, in v0.44.0 — aber NICHT durch Verbreitern von
`BOUNDARY_RE`** (der naive Fix bleibt zurückgezogen, unverändert seit der
Messung unten), **sondern durch einen zweiten, unabhängigen
Normalisierungs-Pass**: `src/runtime/command-normalize.ts` gewinnt
`AMP_BOUNDARY_RE`/`normalizeCommandAmpAware`, den `policyMatchesEvent`
(`src/runtime/intercept.ts`) als DRITTEN Arm konsultiert — nur wenn sowohl
der rohe als auch der primär normalisierte Test verfehlen — und der damit
strikt additiv über den beiden bestehenden Armen liegt, ohne
`BOUNDARY_RE` selbst anzufassen. Der Rest der Messung bezieht sich weiterhin auf master
`c423880` (= master nach PR #383, vor PR #385; NICHT identisch mit dem
ausgelieferten 0.42.0, dem der Normaliser aus PR #383 ganz fehlt). Er
bleibt als Messung gegen `c423880` gültig; die reinen `&`-Zeilen in der
K4-Aufschlüsselung und in der Fail-open-Tabelle beschreiben den
Vor-Fix-Stand der Trigger-Ebene, nicht den heutigen.

**Empfehlung 3 (`98ad072f` als struktureller Blocker für K1) ist inzwischen
umgesetzt und ausgeliefert:** `src/runtime/command-normalize.ts` gewinnt
eine reine Pro-Segment-Sicht (`segmentViewOf`/`CommandSegment`, eigenes
Ziel + komponiertes effektives Ziel), und `src/runtime/intercept.ts`
wertet eine `${REPO}`/`${BRANCH}`/`at_head`-tragende Policy jetzt pro
distinktem, vom Segment attribuierten Repository-Kontext aus, additiv zum
cwd-Kontext, der NIE fällt (`resolveAttributedContexts`, Entscheidung
D-021 in `.ai/runs/2026-08-02-per-repo-gate-scoping-redesign/03-decisions.md`
— vier unabhängige Review-Runden maßen je einen eigenen Fail-open in
einer früheren REPLACE-Variante der Attribution, bevor der additive
Entwurf strukturell dagegen immun gemacht wurde). Das schließt K1s
eigentliche Beobachtung ("die Modelle sind komplementär, nicht
redundant, 6 von 8 Formen divergent") NICHT durch Konsolidierung der
beiden Extraktionsmodule — `bash-prefix-parse.cdTarget` und
`command-normalize`s neue Segment-Sicht bleiben zwei getrennte Module —
sondern macht die Divergenz für den `${REPO}`/`${BRANCH}`/`at_head`-Kanal
ungefährlich: eine falsch (oder gar nicht) attribuierte Zielangabe kann
das cwd-Requirement nie ersetzen, nur ergänzen. Gemessen, nicht nur
behauptet: `scripts/measure-additive-attribution-matrix.mjs`
(`npm run measure:additive-attribution-matrix -- --control <dir>`) fährt
6 Trennzeichen x 8 Formen = 48 Zellen gegen den ausgelieferten 0.43.0-
Kontrollbau und meldete 0/48 Zellen schwächer als 0.43.0 bei diesem Lauf.
Der `cdTarget`-Kanal von `bash-prefix-parse.ts` selbst (Risk-Gate-Kontext,
nicht die `${REPO}`/`${BRANCH}`-Builtins) ist von `98ad072f` unberührt und
bleibt K1s offene Beobachtung.

**Empfehlung 2, Teil (der read-only-Flag-Kanal, `fdee7d0f`) ist umgesetzt
und ausgeliefert — als "slice 1", PR #392, nur für diesen einen der drei
Aufrufstellen.** Neues `src/runtime/shell-word.ts` exportiert
`decodeShellWord` (reine Quote-Entfernung + Escape-Dekodierung: ANSI-C
`\xHH`/`\NNN`/`\uHHHH`, quote-eigene Backslash-Regeln, Lauf-Verkettung —
KEINE `$VAR`/`$()`/Backtick/`~`/Glob-Expansion) und wird jetzt vor jedem
Schreib-Flag-Vergleich in `read-only-bash.ts` angewandt (`find`, `sort`,
`file`; seit Task `2929c5b7` (2026-09-01, ungemessen gegen echtes bash,
nur strukturell dieselbe raw-ODER-decoded-Anwendung) auch `sed` und
`curl`), stets nur auf der RESTRIKTIVEN Seite (erkennt mehr Tokens als
Schreib-Flag, nie weniger). Das schließt K5s drei gemessenen Fail-opens
punktgenau: `find . -"delete"`, `find . -'delete'`, `find . -\delete`
(plus, laut Fix-Beleg, zwei weitere Schreibweisen und die `sort`/`file`-
Geschwisterfälle) klassifizieren nicht mehr als read-only. **Was das
NICHT schließt:** `bash-prefix-parse`s Wert-Dekodierung (K2), fuer die
`decodeShellWord` (Stand dieser Prüfung) dort nicht importiert ist; K2
bleibt offen, unverändert gegenüber der Messung unten. Damit ist auch der
in Empfehlung 2 genannte Reihenfolge-Vorbehalt (`cdTarget`-Kanal erst
nach `98ad072f`) noch nicht relevant geworden: `98ad072f` ist zwar
inzwischen gelandet, aber `bash-prefix-parse`s Wert-Dekodierung selbst
hat diese Primitive noch nicht bekommen. `command-normalize`s Peeling
(K3) hat `decodeShellWord` ebenfalls nicht bekommen und bleibt
unverändert offen (siehe die Fail-open-Klassen-Tabelle unten, Zeile
`command-normalize` peelt nicht); kein anderer Mechanismus adressiert
K3 zum Zeitpunkt dieser Prüfung.

**Der Trigger-seitige Teil von Empfehlung 2 (K1 der Fail-open-Tabelle,
`cf3dff51`) ist inzwischen ebenfalls umgesetzt und ausgeliefert, in zwei
Schritten:** PR #412 baut `normalizeCommandQuoteAware`
(`src/runtime/command-normalize.ts`) als quote-bewussten dritten
Normalisierungs-Pass (vierter Matching-Arm, siehe `intercept.ts`s
eigenen Kommentar), eine eigene, additive Grenzsuche
(`findNextBoundaryQuoteAware`), die einen Boundary-Charakter innerhalb
einer offenen Quote überspringt, und verdrahtet ihn in
`policyMatchesEvent` (`src/runtime/intercept.ts:505-590`) als vierten
OR-Zweig: roh, dann normalisiert, dann amp-bewusst (`aabbad63`), dann
quote-bewusst (`cf3dff51`), jeder Zweig nur additiv gegenüber den
vorherigen. Produktions-Nachweis über dieselbe `runInterceptCli`-Messung
wie bei den Empfehlungen 1 und 3: alle 12 von 12 Zielschreibweisen
(`;`, `|`, `&&`, `(`, Zeilenumbruch) gaten jetzt, gegenüber 0 von 12 vor
der Verdrahtung. PR #419 schließt den daraus folgenden `dry-run`-Parity-
Rest (`f561e44c`, siehe `debug-verb-selection.md`): `harness dry-run`s
eigener Matcher (`src/cli/dry-run.ts`) bekam denselben vierten Zweig.
**Damit sind die Metazeichen-im-gequoteten-Wert-Fail-opens aus der
"Fail-open-Klassen"-Tabelle unten (`A='a; b' git status`,
`A="a; b" git status`) geschlossen; `b093911d` (Backslash-Escape ohne
Quotes, `A=a\ b git status`) bleibt offen, unverändert.** Von den drei
K5/K2/K1-Aufrufstellen der gemeinsamen Unquoting-Familie sind damit zwei
(`read-only-bash` über `fdee7d0f`, der Trigger-Layer über `cf3dff51`)
umgesetzt; `bash-prefix-parse`s Wert-Dekodierung (K2) bleibt die einzige
noch offene.

## Kurzfassung

Die Prämisse der Task lautete: vier offene Bypass-Tasks sind vier
Symptome EINER fehlenden Quote-Abstraktion. Gemessen ergibt sich ein
zweigeteiltes Bild.

- **Die größte einzelne Fail-open-Fläche ist kein Quote-Problem.** Das
  Boundary-Alphabet jedes ausgelieferten `bash_match`-Triggers kennt `&&`, aber
  **nicht einzelnes `&`**. Von 45 gemessenen Fail-opens bei einfacher
  Head-Schreibweise schließt das Hinzufügen von `&` **40**: davon 30 echt,
  10 nur maskiert (die Wertschreibweise bleibt besiegt, bekommt aber
  zufällig eine Boundary). Gemessen, nicht geschätzt: Gegenprobe mit
  gepatchtem Alphabet.
- **Die Quote-Abstraktion ist trotzdem real, und breiter als die Task
  annahm.** Dieselbe Unquoting-Familie schlägt in **drei verschiedenen
  Konsumenten** zu: Wert-Dekodierung (`bash-prefix-parse`), Peeling
  (`command-normalize`) und **Flag-Vergleich** (`read-only-bash`). Der
  read-only-Fail-open reproduziert über Doppelquote, Einfachquote UND
  Backslash-Escape.
- **Der cd-Kanal ist nicht konsolidiert, sondern komplementär**:
  `bash-prefix-parse` sieht `cd`, `command-normalize` sieht `-C`/
  `--work-tree`/`--git-dir`/`env -C`. Jedes ist blind, wo das andere
  sieht (6 von 8 Formen divergent).

## Korrekturen gegenüber Fassung 1

Die Gegenprüfung fand in meinem eigenen Instrument die vierte und fünfte
Nicht-Messung dieses Task-Strangs. Beide sind behoben und neu gemessen:

| Fassung 1 | Defekt | Fassung 2 (korrigiert) |
|---|---|---|
| K5: 1 Fail-open (`find . -"delete"`) | **ein geteilter Sandkasten für alle 29 Formen**: `find . -"delete"` löschte die Fixtures, alle späteren Zeilen zählten still als "sauber" | frischer Sandkasten je Form + Ausführungskontrolle: **20 mutiert, 3 Fail-opens** |
| Kill-Switch-Zeile "am Hook belegt" | `deny-harness-killswitch` ist im geprüften Manifest **gar nicht enthalten**; auch die harmlose Kontrolle ergab keinen Treffer | gegen `docs/examples/full-manifest.yaml` mit **Positivkontrolle je Policy** neu belegt |
| "cd-Kanal: bereits ein Modell" | Korpus emittierte den `-C`-Zweig nie; die Identität galt nur für den cd-Fallback | **6 von 8 Formen divergent**, Behauptung zurückgezogen |
| "schließt 40 der 45" | war eine **Vorhersage** im Ton einer Messung | Gegenprobe mit gepatchtem Alphabet gelaufen: 40 geschlossen |
| Env-Versteck-Befund | aus K2 **abgeleitet**, nicht am Resolver gemessen | Resolver-Probe mit 2 Positiv- und 2 Negativkontrollen |

Zusätzlich fehlten `env`/`nice` im Referee-PATH, wodurch die
Wrapper-Achsen tot waren; sie laufen jetzt.

## Was überhaupt vergleichbar ist

Es gibt **keinen Drei-Wege-Vergleich**. Die Module haben verschiedene
Ausgaben und sind nur paarweise überlappend messbar.

| Modul | Ausgabe | verdrahtet an |
|---|---|---|
| `command-normalize.ts` | `normalized` | `bash_match` raw-OR-normalized-OR-amp-OR-quote-normalized (`src/runtime/intercept.ts:505-590`, dritter Arm seit `aabbad63`, vierter Arm seit `cf3dff51`) |
| | `targetDir`/`targetBase` | nichts (grep-verifiziert) |
| `bash-prefix-parse.ts` | `inlineEnv`, `cdTarget` | Risk-Gate-Kontext (`src/cli/policy/intercept.ts:1026-1056`) |
| `read-only-bash.ts` | Boolean | Risk-Floor, Understanding-Gate-PreToolUse (2 Hooks), Write-Guard |

Die Matrix ist daher als **drei überlappende Zwei-Wege-Vergleiche**
geführt. Das ist ein Ergebnis, kein Scope-Cut.

## Messdisziplin

Gegated wird pro Spaltenfamilie auf deren **eigenes Referenzereignis**:
"verlorene cd-Ziele" nur, wo bash das Ziel betrat; "Phantome" nur, wo
nicht; "falscher Wert" nur, wo bash einen Wert setzte; "wirklich
sauber" nur, wo das Kommando nachweislich lief. Achsen ohne ihr
Referenzereignis gelten als NICHT GEMESSEN und fließen in keine Null.

Fünf eigene Messversuche wurden **verworfen statt berichtet**:
Hook-Probe traf das Understanding-Gate; zweite Probe las Manifest-Namen
statt Treffer; das ausgelieferte Binary 0.42.0 war die falsche Kontrolle
(PR #383 fehlt dort, ein geschlossenes Loch wäre als offen gemeldet
worden); K5 teilte sich einen Sandkasten; die Kill-Switch-Zeile hatte
keine Positivkontrolle.

## Divergenz-Matrix

### K1, cd-Ziel gegen realen `$PWD`

Korpus-intern (messbar nur, wo bash betrat; 29 von 91 Achsen ohne
Referenz):

| Modell | exakt | verloren | falsch | Phantome |
|---|---|---|---|---|
| `bash-prefix-parse.cdTarget` | 102 | 191 | 1 | 28 |
| `command-normalize.targetDir` | 102 | 191 | 1 | 28 |

Außerhalb des Korpus, auf dem Zweig, den er nie emittierte:

| Form | bp | cn |
|---|---|---|
| `cd <T> && git status` | `<T>` | `<T>` |
| `cd ~ && git status` | `~` | `null` |
| `git -C <T> status` | `null` | `<T>` |
| `git --work-tree=<T> status` | `null` | `<T>` |
| `git --git-dir=<T> status` | `null` | `<T>` |
| `env -C <T> git status` | `null` | `<T>` |
| `cd <T> && git -C sub status` | `<T>` | `sub` |

**6 von 8 divergent.** Die Modelle sind nicht redundant, sondern
komplementär: jedes ist blind, wo das andere sieht. Die Identität der
Korpus-Zahlen ist ein Artefakt der Korpus-Auswahl (nur cd-Formen), nicht
eine Eigenschaft der Module.

### K2, Inline-Env-Wert gegen reales `$A` des ausgeführten Kommandos

Messbar nur, wo das gegatete Kommando A wirklich trug (144 von 156
Achsen ohne Referenz):

| exakt | falsch | fehlend |
|---|---|---|
| 111 | 85 | 0 |

Falschklassen (real vs. Modell): `$'a b'` → `"a b"` vs `"$'a"`;
`$'\x70rod'` → `"prod"` vs Literal; `a'b'"c"` → `"abc"` vs Literal;
`'a'b'c'` → `"abc"` vs `"a"`.

Dazu 1653 Fälle der Gegenrichtung, in denen das Modell Env für ein
Kommando behauptet, das sie nicht trägt (`A=x;git status` → `A="x;git"`).
Richtung fail-closed, Wert aber Müll.

### K3, Zuweisungs-Präfixgrenze gegen bashs eigene Konsumption

Messbar nur, wo bash die Zuweisung als Präfix behandelte (67 von 75
Achsen ohne Referenz):

| Modell | stimmt zu | weicht ab |
|---|---|---|
| `bash-prefix-parse` | 196 | 0 |
| `command-normalize` (peelt?) | 99 | 97 |
| `read-only-bash` (read-only?) | n/a | n/a |

`read-only-bash` liefert ein Boolean, keinen Präfixbegriff: es verwirft
in allen 196 Formen (fail-closed by design), also gibt es hier nichts
zuzustimmen oder abzuweichen. Kein gemessener Nullwert.

### K4, Trigger-Verdikt gegen wirklich ausgeführten gegateten Verb

Präzisionsseite **vollständig ungemessen** (75/75 Achsen): der Korpus
enthält keine Form, in der ein anderer als der erwartete Head läuft.
Fehlalarme sind damit nicht quantifiziert.

| Treffer | Fail-open |
|---|---|
| 700 | 1149 |

Aufschlüsselung bei einfacher Head-Schreibweise (347 Formen, alle
gelaufen), mit gemessener Gegenprobe:

| Ursache | Anzahl |
|---|---|
| reines `&` (durch den Alphabet-Fix geschlossen) | 30 |
| `&` UND Quote-Modell gleichzeitig (**maskiert**, nicht gefixt) | 10 |
| reines Quote-Modell (überlebt den Alphabet-Fix) | 5 |
| gesamt verfehlt | 45 |
| nach Hinzufügen von `&` verbleibend | **5** |

Die mittlere Gruppe ist wichtig: der `&`-Fix rettet sie nur zufällig,
indem er unmittelbar vor dem Head eine Boundary liefert. Die betroffenen
Wert-Schreibweisen (`a\ b`, `'a; b'`, `'a && b'`, `"a; b"`, `"a && b"`)
bleiben vom Quote-Modell besiegt.

Die restlichen Fail-opens der Gesamtzahl entfallen auf die bereits
dokumentierten **Head-Schreibweisen** (`"git" status`, `git "status"`,
`\git status`) mit rund 100 % Verfehlung.

### K5, read-only-Verdikt gegen reale Mutation

Frischer Sandkasten je Form, Ausführungskontrolle vorgeschaltet:

| Wirklich mutiert | korrekt abgelehnt | **FAIL-OPEN** |
|---|---|---|
| 20 | 17 | **3** |

| Wirklich sauber | korrekt akzeptiert | fail-closed abgelehnt |
|---|---|---|
| 9 | 5 | 4 |

Die drei Fail-opens: `find . -"delete"`, `find . -'delete'`,
`find . -\delete`, alle drei löschen wirklich, alle drei gelten als
read-only. Das ist Task `2dfdf472`, hier erstmals auf Mutationsebene
gemessen, **und über drei Quote-Schreibweisen hinweg, also dieselbe
Unquoting-Familie wie `cf3dff51`/`b093911d`, angewandt auf ein
Flag-Token statt auf einen Zuweisungswert.**

## Fail-open-Klassen, am Eintrittspunkt belegt

Verifiziert über `dist/cli/main.js dry-run` (lokaler Build) gegen
`docs/examples/full-manifest.yaml`, **mit Positivkontrolle je Policy**,
zum Zeitpunkt dieser Messung; bash-seitig ist in jeder Zeile der
Verb-Lauf per Shim belegt. Siehe "Einordnung je Klasse" unten für den
Stand seither (`d834a065`/`aabbad63` schließen die `&`-Zeile, ohne die
Messung hier zu verändern).

| Policy | Kontrolle | Exploit | Ergebnis (zum Messzeitpunkt) |
|---|---|---|---|
| `deny-kill-switch-bypass` | `harness pause` → Treffer | `A=x&harness pause` | **Fail-open** |
| | | `sleep 0 & harness pause` | **Fail-open** |
| `preflight-before-investigation` | `git status` → Treffer | `A=x&git status` | **Fail-open** |
| `preflight-before-push` | `git push` → Treffer | `A=x&git push` | **Fail-open** |
| `review-before-merge-bash` | `gh pr merge` → Treffer | `A=x&gh pr merge` | **Fail-open** |

Der Kill-Switch ist ein **operator-only Deny**, per Konstruktion durch
keine Session-Evidenz erfüllbar. Ein einzelnes `&` umging ihn zum
Zeitpunkt dieser Messung (seither geschlossen, siehe "Einordnung je
Klasse" unten). Zwei Einordnungen dazu, damit die Schwere nicht
überlesen wird:
`src/cli/init/templates.ts:821` benennt "bash_match's regex coverage of
exotic shell shapes" bereits als bekannte Restlücke, neu ist, dass ein
einzelnes `&` dazugehört. Und `A=x&harness pause` ist nicht read-only,
das Understanding-Gate blockt es in einer nicht approvten Session
weiterhin; live ist der Bypass **nach** dem Approval.

Ebenfalls Fail-open, quote-getrieben, zum Zeitpunkt dieser Messung
(gleiche Methodik): `A=a\ b git status`, `A='a; b' git status`,
`A="a; b" git status`: bash führt `git` mit gesetztem `A` aus, kein
Trigger feuert. **Stand heute geschlossen für die beiden gequoteten
Formen** (`cf3dff51`, siehe "Status seit dieser Messung" oben);
`A=a\ b git status` (Backslash-Escape ohne Quotes, `b093911d`) bleibt
offen, unverändert.

### Env-Indikator vor dem Risk-Gate versteckbar

Am Resolver gemessen (`production-signals` aus dem Operator-Manifest),
2 Positiv- und 2 Negativkontrollen bestanden:

| Schreibweise | bash-Wert | aufgelöst |
|---|---|---|
| `DATABASE_URL=prod` (Kontrolle) | `prod` | production |
| `DATABASE_URL=staging` (Kontrolle) | `staging` | unknown |
| `DATABASE_URL=$'\x70rod'` | `prod` | **unknown** |
| `DATABASE_URL=$'\160rod'` | `prod` | **unknown** |
| `DATABASE_URL=p'r'od` | `prod` | **unknown** |
| `DATABASE_URL=pro\d` | `prod` | **unknown** |
| `DATABASE_URL=$'prod'` | `prod` | production (Substring-Zufall) |
| `DATABASE_URL='prod'` | `prod` | production (Substring-Zufall) |

Vier Schreibweisen verstecken den Produktionsindikator. Die beiden
Treffer sind Zufall, kein Schutz: das Literal enthält zufällig die
Zeichenfolge `prod`.

## Einordnung je Klasse

| Klasse | Richtung | Beleg |
|---|---|---|
| `&` fehlt im Boundary-Alphabet | **fail-open** zum Messzeitpunkt, seither geschlossen: `d834a065` (Template-Ebene, `harness.yaml`-Regex neuer `init`-Läufe, schließt EIN bestehendes materialisiertes Manifest nicht automatisch, `harness apply` schreibt dessen Trigger-Regex nie um; `checkTriggerBoundaryDrift`, task `037cfb7c`, meldet die Drift seither als Fehler) UND `aabbad63` (Engine-Ebene, zweiter, unabhängiger Normalisierungs-Pass in `policyMatchesEvent`, wirkt auch auf ein altes, noch nicht nachgezogenes Manifest) | Hook-Probe mit Pro-Policy-Kontrolle + Shim |
| Metazeichen im gequoteten Wert (`cf3dff51`) | **fail-open** zum Messzeitpunkt, seither geschlossen (PR #412/#419) | Hook-Probe + Shim |
| Backslash-Escape im Wert (`b093911d`) | **fail-open** Trigger, unverändert offen | Hook-Probe + Shim |
| Wert-Dekodierung fehlt (ANSI-C, Verkettung, Backslash) | **fail-open** Risk-Einstufung, unverändert offen | Resolver-Probe mit Kontrollen |
| Flag-Unquoting fehlt (`2dfdf472`) | **fail-open** zum Messzeitpunkt, seither geschlossen (`fdee7d0f`) | K5, reale Mutation, 3 Schreibweisen |
| Modell behauptet Env ohne Export | fail-closed | K2, 1653 Fälle |
| `command-normalize` peelt nicht (97/196) | fail-closed (raw greift) | K3 |
| `read-only-bash` verwirft Gequotetes | fail-closed by design | K5, 4 Fälle |
| Head-Schreibweisen (`"git"`, `\git`) | fail-open, bereits dokumentiert | K4 |

## Empfehlung

1. **Zuerst: `&` ins Boundary-Alphabet aller `policies[].trigger.bash_match`.** Eine
   Zeichenklasse in einem geteilten Regex-Präfix. Gemessene Wirkung:
   45 → 5 verbleibende Fail-opens bei einfacher Head-Schreibweise, und
   der operator-only Deny wird wieder wirksam. Kein Parser, keine
   Abstraktion. **Höchster Wert pro Aufwand im ganzen Cluster.**
   Vorbehalt, ehrlich: die Präzisionsseite ist ungemessen (75/75), die
   Fehlalarm-Kosten des Fixes sind also ein Argument, keine Messung.
   Der Fix braucht einen eigenen Fehlalarm-Korpus.
2. **Dann: die gemeinsame Unquoting-Primitive.** Die Task-Prämisse
   trägt hier, breiter als zunächst geschlossen: dieselbe Familie
   ("dekodiere ein Shell-Wort zu seinem literalen Wert") schlägt in
   `bash-prefix-parse` (Wert), `command-normalize.consumeAssignment`
   (Peeling) und `read-only-bash` (Flag-Vergleich) zu. `cf3dff51`,
   `b093911d` und `2dfdf472` teilen sich damit einen Fix, das sind
   drei der vier offenen Bypass-Tasks. Kostenschätzung: eine
   `decodeShellWord`-Funktion (ANSI-C inkl. Oktal/Hex, Backslash,
   Lauf-Verkettung) plus drei Aufrufstellen.
   **Reihenfolge-Vorbehalt:** am `cdTarget`-Kanal darf sie erst nach
   `98ad072f` landen, solange `cdTarget` den Git-Kontext ERSETZT,
   wirkt jede Genauigkeitsänderung zweiseitig (vier Review-Runden im
   `b093911d`-Run als Beleg). Für den read-only-Flag-Kanal gilt das
   nicht; der kann sofort.
3. **`98ad072f` bleibt der strukturelle Blocker** und wird durch K1
   bestätigt: `bash-prefix-parse` und `command-normalize` sind auf dem
   Zielverzeichnis-Kanal komplementär und divergent (6/8), nicht
   redundant. Eine Segment-Attribution muss beide Quellen zusammenführen.
4. **Head-Schreibweisen** bleiben die größte verbleibende
   Fail-open-Fläche, sind aber eine Abdeckungsfrage von
   `command-normalize`, keine Quote-Abstraktion.

Was die Prämisse angeht: die vier Bypass-Tasks sind **nicht** vier
Symptome einer Ursache, aber auch nicht vier unabhängige Bugs. Drei
(`cf3dff51`, `b093911d`, `2dfdf472`) teilen die Unquoting-Primitive;
`dbc6d303` (False-Positives) liegt auf der Trigger-Ebene und teilt sie
nicht. Der `&`-Befund ist eine fünfte, bisher nicht gefilte Klasse und
sticht sie alle im Verhältnis Wirkung zu Aufwand. **Stand heute**
(siehe "Status seit dieser Messung"): `cf3dff51` und `2dfdf472` sind
beide geschlossen, über getrennte Umsetzungen statt einer gemeinsamen
`decodeShellWord`-Primitive für alle drei; `b093911d` bleibt der
einzige noch offene der drei ursprünglich verbundenen Tasks.

## Offene Lücken dieser Messung

- **K4-Präzisionsseite: 75 von 75 Achsen ungemessen.** Fehlalarme des
  Triggers sind nicht quantifiziert; das betrifft direkt die
  Kosten-Aussage von Empfehlung 1.
- **K1-Phantom-Familie: 62 von 91 Achsen ohne Referenz** (größerer
  Anteil als die 29/91 der Extraktionsfamilie).
- Wrapper-Head-Schreibweisen (`env git`, `nice git`) laufen erst seit
  der Korrekturrunde; die K4-Gesamtzahlen der Fassung 1 enthalten sie
  nicht.
- `deny-session-env-strip` und `deny-pause-sentinel-forgery` sind nur
  quelltextseitig geprüft (gleiche Boundary-Gruppe), nicht gemessen.
- `command-normalize.normalized` wurde nur über sein Trigger-Ergebnis
  gemessen, nicht als String gegen eine bash-Referenz.
- `expire_on_bash_match` ist eine ANDERE Familie (`^gh pr (merge|close)`,
  `^git push origin (master|main)`, verankert, ohne Boundary-Alternation
  und ohne Zuweisungs-Toleranz). Sie wurde weder gemessen noch adressiert;
  der Alphabet-Fix betrifft sie nicht.
- Eine Maschine (WSL2, bash 5.x, GNU findutils). `&`-Backgrounding,
  Job-Control und `find -delete` können anderswo abweichen.
- Die Resolver-Probe rekonstruiert den Merge-Pfad aus
  `src/cli/policy/intercept.ts` (`resolverGit`/`resolverEnv`, Zeilen
  1041–1057), statt den echten PreToolUse-Hook zu fahren.
