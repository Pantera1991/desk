# Wykres 24 h: opis słupka i rozbicie per model

## Po co

W szczegółach użycia (Historia → „Okno 5 h · ostatnie 24 h”) słupki pokazują tylko wysokość.
Właściciel chce jak w CodexBar: najechanie mówi, ile ma dany słupek, a kliknięcie pokazuje,
które modele zapełniły okno. Ma to odpowiadać na pytanie „co mi zjadło limit”.

## Jak działa wykres dziś

48 półgodzinnych słupków; każdy to najwyższy odczyt zapełnienia okna 5 h w swoim przedziale
(`bars24h` w `usage-stats.ts`), czyli stan okna, nie zużycie w tym półgodzinnym przedziale.
Historia (`usage-history.jsonl`) trzyma procenty okien i koszt per sesja, bez modeli.
Model jest w transkryptach Claude Code; skaner (`usage_transcripts.rs`) czyta go już do wyceny.

## Decyzje właściciela

- Rozbicie po kliknięciu = **co zapełniło okno do tej chwili** (wariant A): koszt i tokeny per
  model od początku okna 5 h, w którym jest słupek, do końca słupka.
- Najechanie: linia u góry wykresu, np. „14:30–15:00 · 62% okna 5 h (okno od 12:10)”.
- Wygląd panelu jak w CodexBar: nagłówek z sumą, wiersz per model z kosztem i tokenami.

## Podejście

Liczone na żądanie z transkryptów (nowa komenda), bo zapis per model w historii zacząłby
się dopiero teraz i wszystkie wcześniejsze słupki byłyby puste. Odrzucone: dopisywanie modeli
do `usage-history.jsonl` (puste słupki wstecz) i dzielenie procentu słupka na modele
(Anthropic nie podaje, jak model liczy się do limitu: to byłoby zgadywanie).

## Projekt

- Skaner pamięta przy każdej wiadomości model i tokeny (wejście, zapis i odczyt cache, wyjście).
- Komenda `usage_models(agent, account, from, to)` → lista `{model, cost, tokens}` dla
  wiadomości z `from ≤ t < to`, od najdroższego; modele z zerem tokenów pominięte. Tylko
  konta Claude; dla innych agentów pusta lista. Komenda w `build.rs` i `capabilities` (ACL).
- `bars24h` zwraca też `from`, `to` i `start` (początek okna 5 h słupka; null przy 0%).
- Słupki to przyciski (klawiatura, `aria-label` z opisem). Najechanie albo fokus pokazuje opis
  w linii nad wykresem; zjechanie przywraca zwykły tekst.
- Kliknięcie: panel pod wykresem: „Okno od 12:10 do 15:00: $44.30 · 129M tokenów”, potem
  wiersze `claude-fable-5-2  $41.20 · 120M` z paskiem udziału w koszcie. Ponowne kliknięcie
  tego samego słupka albo Esc zamyka panel (pierwszy Esc zamyka panel, drugi popover).
  Słupek z 0% albo okres bez sesji: „brak sesji Claude Code w tym czasie”.
- Koszt wg cen API, jak w reszcie desk.

## Poza zakresem

- „Tydzień dzień po dniu”.
- Konta Codex (desk nie zna tam modeli z tej samej ścieżki).
- Zapisywanie rozbicia w historii.
