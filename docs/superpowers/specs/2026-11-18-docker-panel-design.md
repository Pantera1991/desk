# Podgląd Dockera w desk

## Po co

Projekty działają w kontenerach na serwerach Dockera w sieci firmowej (np. `Docker1`
`tcp://192.0.2.10:2375` i `Docker2` `tcp://192.0.2.20:2375`, oba po TCP bez TLS).
Dziś, żeby zobaczyć, czy coś leży, zajrzeć w logi albo wejść do kontenera, trzeba otworzyć panel
Dockera w PhpStormie. desk i tak trzyma terminale wszystkich projektów, więc ma tam być:

- rzut oka, czy wszystko chodzi (status projektów compose i kontenerów, jak kolorowe kropki
  w PhpStormie),
- logi i powłoka kontenera w **kafelku** desk,
- sprzątanie: usuwanie obrazów.

## Cele

- Przycisk z wielorybem w górnym pasku otwiera dymek z drzewem w stylu PhpStorma:
  serwer → projekty compose → kontenery, a pod każdym serwerem także „Kontenery bez compose”,
  „Obrazy”, „Sieci” i „Woluminy”.
- Status przy projekcie i kontenerze: zielony (wszystko `running`), żółty (część działa, część nie,
  albo `restarting`/`paused`), szary (nic nie działa: `exited`/`created`), czerwony przy
  serwerze, który nie odpowiada (z treścią błędu).
- Na kontenerze dwie akcje: **Logi** i **Powłoka**, każda otwiera nowy kafelek. Na projekcie compose:
  **Logi** całego projektu w kafelku.
- Na obrazie akcja **Usuń**, zawsze z potwierdzeniem, które podaje serwer, nazwę i rozmiar obrazu.
- Serwery ustawiane w Opcjach: nowa grupa **Docker** z listą (nazwa + adres), dodawanie,
  edycja, usuwanie.

## Czego nie robimy

- Żadnych innych zmian na serwerach: bez start/stop/restart kontenerów, bez `compose up/down`,
  bez usuwania kontenerów, sieci i woluminów, bez `prune`. Jedyna akcja zmieniająca serwer to
  usunięcie jednego obrazu po potwierdzeniu.
- Bez `--force` przy usuwaniu obrazu: gdy obrazu używa kontener, pokazujemy błąd Dockera.
- Sieci i woluminy tylko do odczytu (nazwa, sterownik).
- Bez TLS, SSH i kontekstów `docker context`: tylko adres `tcp://host:port` (i ewentualnie
  `unix://`, bo to ten sam parametr `-H`, ale nie testujemy tego osobno).
- Bez importu serwerów z PhpStorma.
- Bez powiadomień, gdy kontener padnie (może później).
- Nic nie odpytuje serwerów w tle: tylko gdy dymek jest otwarty.

## Ograniczenia

- **Zero pracy w tle.** Lekcja z PR #71 (pętla obserwatora plików zjadała CPU): dymek odświeża
  dane co 5 s *tylko gdy jest otwarty* (jak `cpu-popover.ts`), timer znika przy zamknięciu.
  Następne odświeżenie nie rusza, dopóki poprzednie nie skończy.
- Każde wywołanie `docker` ma limit czasu (3 s). Serwer, który nie odpowiada, nie blokuje
  pozostałych ani okna (odpytywane równolegle, poza wątkiem głównym: `#[tauri::command(async)]`
  albo `spawn_blocking`).
- Wymaga komendy `docker` (sam klient CLI, bez Docker Desktop) w PATH, który desk bierze z powłoki
  logowania. Bez niej dymek mówi, że brakuje `docker`, i nic więcej nie robi.
- Adres serwera trafia do komendy jako osobny argument (`Command::arg`), nigdy przez `sh -c`
  sklejone z tekstem z Opcji. Tak samo nazwy kontenerów i obrazów. Przy kafelkach (tam komenda
  idzie do tmux jako tekst) każdy element jest cytowany tak jak inne komendy `runs`.
- Wszystkie napisy przez `t()` (`pl.ts` wyznacza klucze, `en.ts` musi mieć wszystkie), błędy z Rusta
  przez `tr!`.
- Linux i macOS. Na Windows ma działać tak samo (komenda `docker.exe`), ale nie sprawdzamy.

## Sposoby (wybrany: A)

- **A. Wszystko przez komendę `docker` (wybrany).** Lista: `docker -H <adres> ps -a --format json`,
  `image ls --format json`, `network ls --format json`, `volume ls --format json`; usunięcie:
  `image rm <id>`; kafelki: `logs -f` i `exec -it`. Bez nowych zależności, tak jak desk woła
  dziś `git` i `tmux`, a do logów i powłoki w kafelku komenda `docker` i tak jest potrzebna.
- B. Rust rozmawia z Docker Engine API po HTTP, komenda `docker` tylko w kafelkach. Szybsza lista
  i pełniejsze dane, ale nowa zależność (klient HTTP) i więcej kodu, a CLI i tak zostaje.
  Odrzucony: mały zysk za podwójną drogę do Dockera.

Wybrał użytkownik: A.

## Jak to działa

### Ustawienia (layout.json)

Nowe pole `dockerHosts: [{ "name": "Docker1", "url": "tcp://192.0.2.10:2375" }]`,
domyślnie puste (stare `layout.json` bez pola działają). Kolejność z Opcji = kolejność w dymku.
Adres musi zaczynać się od `tcp://` albo `unix://`; inaczej Opcje pokazują błąd i nie zapisują.
Nazwy serwerów unikalne. Oba pola (`dockerHosts`, `docker`) trzeba dodać też do struktury
`Layout` w `src-tauri/src/layout.rs`, inaczej zapis z Rusta je gubi.

### Rust (`src-tauri/src/docker.rs`)

- `docker_overview(hosts) -> Vec<HostView>`: dla każdego serwera równolegle 4 komendy `ls`
  z limitem 3 s. `HostView` = nazwa, adres, `error: Option<String>` albo listy: kontenery (id,
  nazwa, obraz, stan, status tekstowy, projekt compose z etykiety `com.docker.compose.project`,
  usługa z `com.docker.compose.service`), obrazy (id, repo:tag, rozmiar, utworzony), sieci (nazwa,
  sterownik), woluminy (nazwa, sterownik).
- Format `--format '{{json .}}'` (działa też w starszych klientach), jeden obiekt JSON na linię;
  parsowanie w czystych funkcjach z testami na przykładowym wyjściu.
- `docker_image_rm(host, image) -> Result<(), String>`: `host` to nazwa z `dockerHosts` (adres
  bierze Rust), `image` to `repo:tag` albo id; `docker -H url image rm image`, błąd Dockera wraca
  do okna.
- Brak `docker` w PATH: osobny, rozpoznawalny błąd („nie znaleziono komendy docker”).

### Dymek (`src/docker-popover.ts` + `src/docker-view.ts`)

Wzór: `cpu-popover.ts` (otwieranie pod przyciskiem, Esc, klik obok, zachowany scroll) i
`cpu-view.ts` (czysta funkcja HTML → testy vitest).

```
🐳 Docker                                          ⟳
▾ ● Docker1                    13 kontenerów
   ▸ ● enova-order-verification              1/1
   ▾ ◐ web                                    2/3
       ● web-app-1        nginx:1.27   Up 3 days     [Logi] [Powłoka]
       ○ web-worker-1     web:latest   Exited (1)    [Logi] [Powłoka]
   ▸ Kontenery bez compose (0)
   ▸ Obrazy (24)
       mm/web:latest   412 MB   3 dni temu         [Usuń]
   ▸ Sieci (6)
   ▸ Woluminy (9)
▸ ✕ Docker2        nie odpowiada: timeout po 3 s
```

- Rozwinięcie gałęzi pamiętane w `localStorage` (wygoda na tę przeglądarkę, bez gwarancji).
- Przycisk w górnym pasku widać tylko, gdy jest co najmniej jeden serwer w Opcjach (serwery
  dodaje się w Opcje → Docker). Gdy ostatni serwer zniknie przy otwartym dymku, dymek się zamyka.

### Kafelki z logami i powłoką

**Nie** przez ⌘U/`run`: `open_session` przyjmuje dla `run` tylko komendy, które projekt sam
definiuje (`project::run_targets`, `src-tauri/src/lib.rs:224`), i to jest granica
bezpieczeństwa (`layout.json` nie może wstrzyknąć komendy). Zostaje nietknięta.

Zamiast tego nowy rodzaj kafelka (agent) `docker`. W układzie zapisany jest tylko opis, nie
komenda: nowe pole `layout.docker[key] = { host: "<nazwa z dockerHosts>", target: "<kontener
albo projekt>", kind: "logs" | "projectLogs" | "shell" }`, tytuł w `layout.titles[key]`.
Komendę buduje i cytuje **Rust** w `open_session` (agent `docker`), i tylko dla serwera, który
jest w `dockerHosts` (po nazwie; adres bierze z `dockerHosts`, nie z wpisu kafelka). Nazwa
celu musi pasować do nazw Dockera (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`), inaczej błąd.

- `logs`: `docker -H <url> logs -f --tail 500 <kontener>`, tytuł `logi: <kontener>`.
- `projectLogs`: `docker -H <url> compose -p <projekt> logs -f --tail 200`, tytuł
  `logi: <projekt>`. Wymaga wtyczki `docker compose`; overview sprawdza ją raz
  (`docker compose version`), a bez niej przycisku „Logi” przy projekcie nie ma.
- `shell`: `docker -H <url> exec -it <kontener> sh -c 'command -v bash >/dev/null && exec bash || exec sh'`,
  tytuł `sh: <kontener>`. Przycisk wyłączony, gdy kontener nie jest `running`.
- Folder kafelka: lokalny folder projektu o tej samej nazwie co projekt compose (porównanie bez
  wielkości liter), jeśli desk go zna (lista projektów / `projectsDir`); inaczej folder domowy.
- **Po restarcie komputera kafelki Dockera nie wracają** (decyzja użytkownika): przy odtwarzaniu
  układu (`restore`) sesja `docker`, której tmux już nie ma, nie jest uruchamiana, a jej wpis
  znika z `layout.docker`/`titles`. Zamknięcie i otwarcie samego desk (tmux żyje) zostawia
  kafelek jak każdy inny. Dzięki temu desk nigdy sam nie łączy się z serwerem bez kliknięcia.
- Testy budowania i cytowania komend są w Rust.

### Usuwanie obrazu

Lista obrazów ma **wiersz na tag** (decyzja użytkownika); obraz bez tagu to jeden wiersz
`<none>` z krótkim id.

- „Usuń” na tagu: `docker -H <url> image rm <repo:tag>`. Gdy ten sam obraz (id) ma inne tagi,
  potwierdzenie mówi wprost, że zdejmuje tylko tag i miejsce się nie zwolni:
  „Zdjąć tag `web:1.4` z Docker1? Obraz ma też `web:latest`, więc nic nie zostanie usunięte z
  dysku.” Inaczej: „Usunąć obraz `web:1.4` (412 MB) z Docker1?”.
- „Usuń” na `<none>`: `docker -H <url> image rm <id>`.
- Nigdy `--force`. Błąd Dockera (np. obraz używany przez kontener) trafia do toastu.
- Po „Tak”: komenda, toast z wynikiem, od razu odświeżenie listy. Przycisk wyłączony, dopóki
  komenda trwa. Okno potwierdzenia: to samo, którego używają Opcje do potwierdzeń.

## Testy

- Rust: parsowanie każdego z czterech wyjść `--format json` (w tym puste, linia z błędem),
  wyliczanie statusu projektu, rozpoznanie braku `docker`, limit czasu (komenda, która śpi dłużej).
  Bez testów na prawdziwym serwerze.
- Rust: budowanie komend kafelków `docker` (każdy `kind`), odrzucenie serwera spoza
  `dockerHosts` i nazwy celu ze znakami spoza wzorca, pominięcie kafelka `docker` przy `restore`.
- TS (vitest): `docker-view` dla: serwer z błędem, projekt mieszany (żółty), kontenery bez
  compose, obraz z kilkoma tagami (tekst potwierdzenia), `<none>`, brak wtyczki compose.
- `pnpm check` musi przejść.
- Ręcznie, dopiero za zgodą użytkownika: otwarcie dymka na `Docker1`, logi i powłoka w kafelku.
  Usuwanie obrazu ręcznie tylko na obrazie wskazanym przez użytkownika.

## Zostawione budującemu

- Ikona wieloryba (SVG w stylu pozostałych ikon `topbar.ts`) i dokładne kolory statusów z motywu.
- Czy grupy „Obrazy/Sieci/Woluminy” są domyślnie zwinięte (propozycja: tak).
- Format rozmiaru i wieku obrazu (propozycja: jak `docker image ls`).
- Skrót klawiszowy do dymka: nie dodajemy, chyba że jest wolny i pasuje do reszty.
