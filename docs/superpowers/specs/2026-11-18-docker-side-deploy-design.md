# Docker w bocznym panelu i wdrażanie z lokalnego folderu

Dopisek do `2026-11-18-docker-panel-design.md` (panel Dockera) i
`2026-11-18-docker-restart-design.md` (restart kontenera, zaakceptowany). Zmienia z pierwszego:
miejsce panelu (dymek → boczny panel) i „Czego nie robimy” (dochodzi wdrożenie projektu).

## Po co

- Panel Dockera ma być pod ręką jak panel plików (Ctrl+Shift+F): otwarty obok terminali, póki
  się go nie zamknie, ze skrótem. Dymek znikał po każdym kliknięciu obok.
- Projekty na `Docker1` są dziś wdrażane z lokalnych folderów (`~/PhpstormProjects/<projekt>`)
  komendą `docker -H … compose up`: pliki compose są do tego pisane (komentarz w
  `mm-general/docker-compose.yml`: `.env` czytany tam, skąd się uruchamia; port przypięty do
  `192.0.2.10`). Przycisk ma to robić za użytkownika, z potwierdzeniem.

## Cele

1. **Boczny panel Dockera** (wybór użytkownika: wariant A).
   - Panel po prawej, jak panel plików: nagłówek „🐳 Docker”, ⟳ (odśwież teraz), × (zamknij),
     pod nim to samo drzewo co dziś w dymku (`renderDocker`).
   - Otwieranie i zamykanie: skrót **⌘G / Ctrl+Shift+G** (nowy wpis `docker` w `src/keys.ts`,
     grupa „window”, do zmiany w Opcje → Skróty), przycisk 🐳 w górnym pasku i × w nagłówku.
   - Klik obok **nie** zamyka panelu (to nie dymek). Esc też nie (Esc należy do terminali).
   - Szerokość zmieniana przeciąganiem lewej krawędzi (jak `.side .splitter`), pamiętana w
     `localStorage` `desk.dockerWidth`; domyślnie 380 px, min. 280 px.
   - Otwarcie panelu Dockera **nie** włącza trybu skupienia (`focusMode`: jedna karta w środku,
     reszta w pasku) — siatka kafelków tylko się zwęża. Może być otwarty razem z panelem plików
     (kolejność od lewej: siatka, Docker, pliki).
   - Czy panel był otwarty, pamiętane w `localStorage` `desk.dockerPanel`; po starcie desk panel
     wraca otwarty, jeśli był.
2. **Dymek znika.** Przycisk 🐳 w górnym pasku zostaje (widoczny, gdy jest ≥1 serwer w Opcjach)
   i przełącza boczny panel; `aria-pressed` pokazuje, czy panel jest otwarty. *Decyzja
   budującego (nie użytkownika): jedno miejsce zamiast dwóch.*
3. **Restart kontenera** — wg `2026-11-18-docker-restart-design.md`, w nowym panelu.
4. **„Wdróż” przy projekcie compose** (wybór użytkownika: wariant A — w kafelku, z potwierdzeniem).
   - Przycisk przy wierszu projektu compose, **tylko** gdy projekt ma otwartą kartę w desk
     (dopasowanie: „Decyzje budującego” pkt 1) i folder tej karty ma plik compose (`compose.yaml`,
     `compose.yml`, `docker-compose.yaml` albo `docker-compose.yml`).
   - Potwierdzenie (zawsze): „Wdrożyć `mm-general` na Docker1 z `~/PhpstormProjects/mm-general`?
     Gałąź: `main`, 3 niezacommitowane zmiany.” Gdy zmian nie ma: „…Gałąź: `main`, bez
     niezacommitowanych zmian.” Gdy to nie repozytorium gita: bez części o gałęzi.
   - Po „Tak” otwiera się kafelek (`docker` agent, nowy `kind: "deploy"`, tytuł `wdróż: <projekt>`)
     w lokalnym folderze projektu z komendą
     `docker -H <url> compose -p <projekt> up -d --build`. Przebieg budowania widać w kafelku;
     po zakończeniu zostaje powłoka. Panel pokazuje nowy stan przy kolejnym odświeżeniu.

## Czego nie robimy

- Wdrażania projektów, których nie ma jeszcze na serwerze (przycisk tylko przy istniejących).
- `compose down`, usuwania usług, `--force-recreate`, `--remove-orphans`, `pull`.
- Wyboru pliku compose ani profilu (compose sam wybiera plik w folderze, jak w terminalu).
- Liczenia różnic między lokalnym plikiem a tym, co działa na serwerze.
- Dymka (usunięty, zastąpiony panelem).

## Ograniczenia

- **Zero pracy w tle przy zamkniętym panelu**, jak dotąd. Otwarty panel odpytuje co 5 s, nigdy
  dwa zapytania naraz (ta sama logika co w obecnym dymku: `pending`, generacja, `again`). Dodatkowo:
  gdy okno desk jest ukryte albo zminimalizowane (`document.hidden`), odpytywanie stoi i rusza
  od razu po powrocie.
- **Kafelek wdrożenia nigdy nie rusza sam.** Jak pozostałe kafelki Dockera: po restarcie komputera
  nie wraca; po zamknięciu i otwarciu desk (tmux żyje) tylko się podpina, komenda nie uruchamia
  się drugi raz.
- **Bezpieczeństwo kafelka wdrożenia** (granica jak w `tile_command`): `layout.docker[key]`
  trzyma tylko `{host, target, kind: "deploy"}`. Rust w `open_session` sprawdza, że serwer jest
  w `dockerHosts`, `target` przechodzi `valid_name`, folder kafelka (`path`) istnieje, jego nazwa
  równa się `target` (bez wielkości liter) i ma jeden z czterech plików compose; inaczej błąd.
  Komenda składana i cytowana w Rust.
- Gałąź i liczba zmian: nowa komenda Rust `git_status_summary(path) -> { branch, dirty }`
  (`git status --porcelain`, ten sam sposób wołania gita co `git.rs`, z limitem czasu); w
  folderze bez gita `null`.
- Napisy przez `t()` / `tr!`, pl + en.

## Sposoby

- Panel: **A. boczny panel (wybrany)**; B. dymek + sam skrót (odrzucony: znika po kliknięciu obok).
- Wdrożenie: **A. w kafelku (wybrany)**; B. w tle z komunikatem (odrzucony: minuty bez podglądu,
  nieczytelny błąd budowania).
- Restart: **pojedynczy kontener (wybrany)**; projekt compose i oba (odrzucone).

## Decyzje budującego po recenzji (do sprawdzenia przez użytkownika)

1. **Który lokalny folder — zawsze folder projektu otwartego w desk, nigdy inny (decyzja
   użytkownika).** Kandydatami są tylko projekty, które mają otwartą kartę w siatce desk (ścieżki
   kart), nie lista `api.listProjects` ani foldery spoza desk. Karta pasuje do projektu compose,
   gdy jej ścieżka równa się etykiecie kontenera `com.docker.compose.project.working_dir`
   (ścieżka ostatniego wdrożenia) albo — gdy żadna tak nie pasuje — gdy nazwa jej folderu równa się
   nazwie projektu (bez wielkości liter). Brak otwartej karty albo więcej niż jedna pasująca —
   przycisku „Wdróż” nie ma. Nigdy nie bierzemy po prostu aktywnej karty dla dowolnego projektu.
   Ścieżka zawsze w potwierdzeniu. Rust czyta etykietę razem z pozostałymi (`Container.workingDir`).
2. **Nazwa projektu.** `-p` dostaje nazwę z etykiety `com.docker.compose.project` (prawdziwą nazwę
   na serwerze), nie nazwę folderu; folder może się nazywać inaczej (dopasowany po `working_dir`).
3. **Bez wtyczki compose** (`overview.compose == false`) przycisku „Wdróż” nie ma. Budowanie wysyła
   lokalny kontekst na serwer — tak samo jak dziś z terminala; zamierzone.
4. **Gałąź i zmiany.** `git_status_summary` używa tego samego uruchamiania z limitem czasu co
   `docker.rs` (`run`, 3 s; wspólny moduł zamiast blokującego `git()` z `git.rs`). Liczba zmian to
   wszystkie linie `git status --porcelain` (też nowe, nieśledzone pliki). Brak gita, błąd albo
   przekroczony czas → potwierdzenie bez części o gałęzi.
5. **Kafelek wdrożenia.** `openDockerTile` dostaje ścieżkę wprost dla `deploy`. Rust w
   `open_session` dla `kind: "deploy"` sprawdza: serwer w `dockerHosts`, `target` przez
   `valid_name`, folder kafelka istnieje i ma jeden z czterech plików compose (bez porównywania
   nazwy folderu — dopasowanie robi panel, a nazwa może się różnić, pkt 1–2). `tile_command`
   dostaje folder jako argument. Ścieżka pochodzi z klucza sesji, `layout.docker[key]` dalej trzyma
   tylko `{host, target, kind}`.
6. **Drugie „Wdróż” tego samego projektu na tym samym serwerze**, gdy kafelek wdrożenia jest
   otwarty: bez potwierdzenia przenosi do istniejącego kafelka zamiast uruchamiać drugie wdrożenie.
7. **Układ.** Panel Dockera to osobny element w `.middle`, między `.stage` a panelem plików;
   tryb skupienia zależy tylko od panelu plików (`Side.isOpen`). Esc z obsługi dymka znika.
8. **Skrót** `Super+KeyG` (⌘G / Ctrl+Shift+G) jest wolny w `src/keys.ts`.

## Zostawione budującemu

- Czy `DockerPanel` to przerobiony `DockerPopover`, czy nowa klasa korzystająca z tej samej logiki
  odpytywania (propozycja: przerobić, testy przenieść).
- Wygląd nagłówka i przycisków (wzór: `.side-head`).
- Gdzie trzymać listę lokalnych projektów (propozycja: pobrać raz przy otwarciu panelu i przy ⟳).
