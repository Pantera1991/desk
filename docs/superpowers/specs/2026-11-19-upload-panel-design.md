# Panel Wysyłka (rsync na serwery)

## Po co

Czasem trzeba przenieść plik z projektu na serwer, np. zrzut bazy (`.sql`, `.sql.gz`), żeby go tam
zaimportować. Dziś to ręczne `rsync`/`scp` w terminalu: trzeba pamiętać użytkownika, klucz i nazwę
serwera. desk i tak trzyma terminale wszystkich projektów, więc wysyłka będzie w nim, tak jak panel
Dockera.

## Cele

- Boczny panel **Wysyłka**, podobny do panelu plików: drzewo plików projektu z aktywnej karty.
- Wybierasz plik i serwer, potwierdzasz, a `rsync` przez SSH wysyła go do katalogu domowego
  użytkownika na serwerze (`/home/<user>/`).
- Serwery w Opcjach: nazwa z `/etc/hosts` (albo wpisana) i użytkownik. Logowanie tylko kluczem SSH.
- Duże pliki (setki MB, GB): postęp widać, przerwaną wysyłkę da się dokończyć.

## Czego nie robimy

- Wysyłki folderów (na razie tylko pliki).
- Wyboru katalogu na serwerze (zawsze katalog domowy).
- Pobierania z serwera.
- Importu zrzutu ani żadnych komend po wysyłce.
- `--delete` ani usuwania czegokolwiek na serwerze.
- Haseł (tylko klucz; hasło do samego klucza wpisuje się w kafelku).
- Windowsa (nie ma tam `rsync`).
- Czytania `~/.ssh/config`.

## Czego nie wolno zepsuć

- Wysyłka nigdy nie startuje sama: ani po restarcie desk, ani z „Przywróć”, ani z ⌘⇧T.
  Tylko z kliknięcia z potwierdzeniem, jak „Wdróż” w panelu Dockera.
- desk nigdy sam nie przyjmuje klucza nowego serwera. Pytanie SSH „yes/no” przy pierwszym
  połączeniu widzi i odpowiada człowiek.
- Bez pracy w tle: zamknięty panel nic nie robi i nie łączy się z serwerami.

## Sposoby (wybrany: 1)

1. **Wysyłka w kafelku (wybrany).** Panel to drzewo, lista serwerów i przycisk „Wyślij”. Kliknięcie
   otwiera kafelek z terminalem, w którym działa `rsync`. Postęp pokazuje sam `rsync`. Ctrl+C przerywa
   wysyłkę, a zamknięcie kafelka najpierw pyta (zobacz „Zamykanie w trakcie wysyłki”). Pierwsze połączenie działa, bo pytanie SSH o klucz serwera
   pojawia się w terminalu. Korzysta z gotowych kafelków Dockera i z tego, że komendę składa i cytuje
   Rust.
2. **W tle z paskiem w panelu.** Ładniejsze, ale wymaga odczytu postępu, przerywania i limitów czasu.
   Pytanie o klucz serwera nie ma gdzie się pojawić, więc albo pierwsze połączenie trzeba zrobić ręcznie,
   albo desk przyjmowałby klucze sam. Odrzucony.
3. **Przycisk w panelu plików.** Odrzucony, bo użytkownik chce osobny panel.

Wybrał użytkownik: 1.

## Jak działa

### Opcje → Wysyłka

- Lista serwerów, każdy wiersz ma trzy pola:
  - **serwer:** nazwa z `/etc/hosts`, podpowiadana z listy (`<datalist>`), albo wpisana ręcznie;
  - **użytkownik:** wymagany;
  - **klucz:** opcjonalna ścieżka do pliku, np. `~/.ssh/server.key`. Pusta oznacza domyślne klucze
    `ssh` (`~/.ssh/id_*`).
- Zapis jak przy serwerach Dockera: wersja robocza, przycisk „Zapisz”, sprawdzenie przed zapisem
  (puste pola, niedozwolone znaki, ta sama para serwer i użytkownik dwa razy).
- Pole w `layout.json`: `uploadHosts: [{ host, user, key }]`, także w Rust `Layout`, z domyślną pustą
  listą. Stare pliki bez tego pola działają bez zmian.
- Podpowiedzi serwerów zwraca nowa komenda Rust, która czyta `/etc/hosts`. Bierze nazwy (bez adresów IP)
  i pomija `localhost`, `ip6-*` oraz nazwy kończące się na `.loc`, `.local` i `.internal`. Na Windowsie
  zwraca pustą listę.

### Panel

- `aside.side.upload` obok panelu Dockera. Kolejność: siatka, Docker, Wysyłka, pliki.
  Szerokość i stan otwarcia trzymamy w localStorage, jak w Dockerze.
- Otwierany skrótem, przyciskiem w górnym pasku albo zamykany przez ×. Przycisk i skrót są widoczne
  tylko wtedy, gdy w Opcjach jest co najmniej jeden serwer (jak 🐳).
- **Na górze:** wybór serwera (`<select>`, opisy w postaci `user@serwer`). Ostatni wybór zapamiętujemy
  w localStorage.
- **Niżej:** drzewo plików projektu z aktywnej karty. Używa `FileTree`/`api.projectFiles` z panelu
  plików, więc widać też pliki z `.gitignore`, a zrzuty zwykle tam właśnie są. Po zmianie aktywnej
  karty drzewo się przeładowuje.
- Przy pliku jest przycisk **„Wyślij”**, przy folderze go nie ma. Kliknięcie otwiera okno
  potwierdzenia: „Wysłać `<plik>` (`<rozmiar>`) do `user@serwer:~/<nazwa>`? Plik o tej nazwie na
  serwerze zostanie nadpisany.” `<nazwa>` to nazwa pliku po `canonicalize` (przy dowiązaniu nazwa
  celu). Jeśli nazwa serwera zawiera `prod`, okno ma czerwone ostrzeżenie. Gdy ten sam plik do tego
  samego serwera jeszcze się wysyła, „Wyślij” przenosi do jego kafelka bez pytania („Ten plik już się
  wysyła.”); zakończona wysyłka tego pliku kończy się i po potwierdzeniu startuje od nowa.
- Bez aktywnego projektu panel pokazuje „Otwórz kartę projektu”.
- Jeśli brakuje `rsync` albo `ssh`, panel pokazuje „Brak rsync/ssh” i nie ma przycisków.
  Sprawdza to `agents::which`.

### Kafelek

- `layout.json` trzyma tylko `{ host, user, file }`. `file` to ścieżka względem folderu projektu.
  Rust sam składa komendę i odmawia, gdy:
  - pary serwer i użytkownik nie ma w Opcjach;
  - plik leży poza folderem projektu (po `canonicalize`) albo nie jest zwykłym plikiem;
  - nazwa serwera, użytkownik albo klucz mają znaki spoza dozwolonego zestawu (zestaw jak
    `valid_name`; dla klucza ścieżka, bez cudzysłowów i spacji).
- Komenda, cytowana przez `shell_quote`:
  ```
  rsync -z --partial --progress -e 'ssh [-i <klucz>] -o IdentitiesOnly=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no' -- '<abs plik>' '<user>@<serwer>:'
  ```
  - `--progress` zamiast `--info=progress2`: przy jednym pliku pokazuje to samo (procent, prędkość,
    czas do końca), a działa też ze starym `rsync` 2.6.9 i z openrsync na macOS (decyzja: Claude).
    macOS jest w zakresie, ale bez testu ręcznego.
  - Do `rsync` idzie ścieżka po `canonicalize`, więc dowiązanie nie zostanie pominięte.
  - `~` na początku ścieżki klucza rozwija Rust.
  - Pusty cel po `:` oznacza katalog domowy.
  - `-z` jest bezpieczne także dla `.gz`, bo `rsync` domyślnie nie kompresuje już skompresowanych
    rozszerzeń.
  - `IdentitiesOnly` dajemy tylko razem z `-i`.
  - Po zakończeniu kafelek zostaje otwarty z wynikiem, jak przy Dockerze (`exec $SHELL -l`).
- Bramka jak przy „Wdróż”:
  - `open_session` odmawia nowej sesji wysyłki bez `startUpload`;
  - kafelki wysyłki nie wracają po restarcie, a „Przywróć” i ⌘⇧T ich nie uruchamiają ponownie
    (odpowiednik `blockedDeploy`).
- Tytuł kafelka: `wyślij: <plik> → <serwer>`. Rozmiar kafelka jak przy Dockerze (`AUX_SIZE`).
- Drugie „Wyślij” na tym samym pliku i serwerze, gdy kafelek już jest, przenosi do niego zamiast otwierać
  drugi (jak „Logi” w Dockerze).
- Rozmiar pliku do okna potwierdzenia zwraca nowa komenda Rust (ten sam sprawdzony plik w projekcie).

### Zamykanie w trakcie wysyłki (decyzja użytkownika)

Zwykły kafelek w desk po ✕ tylko się odpina, a proces dalej działa w tmux. Kafelek wysyłki zachowuje
się inaczej:

- **✕ (i ⌘Q na kafelku), gdy `rsync` jeszcze działa:** okno „Trwa wysyłanie `<plik>` do `<serwer>`.
  Przerwać i zamknąć?” z dwoma przyciskami:
  - **„Przerwij i zamknij”:** kończy sesję (jak „kill”), więc `rsync` staje. Dzięki `--partial`
    ponowne „Wyślij” dokończy przerwaną wysyłkę.
  - **„Kontynuuj”:** nic nie zmienia, kafelek zostaje otwarty, a wysyłka trwa.
- **✕, gdy `rsync` już się skończył:** kafelek zamyka się bez pytania i kończy sesję, bo nie ma
  czego pilnować.
- Czy `rsync` jeszcze działa, sprawdza Rust na żądanie, tylko w chwili zamykania, bez odpytywania.
  W tmux służy do tego bieżąca komenda panelu, w natywnym PTY proces potomny. Sposób wybiera budujący.
- **Wyjście z desk przy trwających wysyłkach** (decyzja: Claude, to samo zachowanie co przy ✕): okno
  „Trwa N wysyłek. Przerwać i wyjść?” z przyciskami „Przerwij i wyjdź” albo „Wróć”.
- **Po awarii albo zabiciu desk** (tmux przeżył): przy starcie trwająca wysyłka wraca jako kafelek, jak
  żywe kafelki Dockera, a zakończona nie wraca. Nigdy nic nie startuje od nowa.
- ⌘⇧T i „Przywróć” nie uruchamiają ponownie zamkniętej wysyłki.

### Kod (wzór: Docker)

- `src/upload-view.ts`: czyste funkcje (render panelu, sprawdzanie serwerów, robocza wersja Opcji,
  bramka).
- `src/upload-panel.ts`: panel.
- `src-tauri/src/upload.rs`: typy, sprawdzanie, składanie komendy, odczyt `/etc/hosts`.
- Wpięcie w `app.ts`, `settings.ts`, `keys.ts`, `topbar.ts`, `api.ts`, `lib.rs` i `layout.rs`, tłumaczenia
  w `pl.ts` i `en.ts`.

## Testy

- **TS:**
  - render: brak projektu, brak rsync, plik z przyciskiem, folder bez przycisku;
  - sprawdzanie serwerów i robocza wersja Opcji;
  - bramka po restarcie i przy „Przywróć”;
  - ✕ przy trwającej wysyłce pyta: „Przerwij” kończy sesję, „Kontynuuj” nic nie zmienia;
  - ✕ po zakończonej wysyłce zamyka bez pytania;
  - wyjście z desk przy trwających wysyłkach pyta;
  - drugie „Wyślij” przenosi do istniejącego kafelka;
  - skrót w `keys.test.ts`.
- **Rust:**
  - składanie komendy (z kluczem i bez);
  - odmowy: nieznany serwer, plik poza projektem, `..`, dowiązanie wychodzące poza projekt,
    złe znaki;
  - wysyłka nie startuje bez potwierdzenia;
  - odczyt `/etc/hosts` z filtrowaniem;
  - zapis i odczyt `uploadHosts`.
- **Ręcznie na Linuksie:**
  - wysłanie zrzutu na `example-dev`;
  - przerwanie i dokończenie (`--partial`);
  - pierwsze połączenie z serwerem (pytanie yes/no w kafelku);
  - zły klucz daje czytelny błąd, bez pytania o hasło;
  - ✕ w trakcie wysyłki: „Kontynuuj” i „Przerwij” (`rsync` naprawdę staje).

## Zostawione budującemu

- Skrót: wolny, w grupie `window`, sprawdzony z `keys.ts` i zarezerwowanymi skrótami
  (propozycja: Ctrl+Shift+U / ⇧⌘U).
- Ikona przycisku w górnym pasku.
- Dokładne teksty (pl/en).
- Gałąź: na `feat/docker-panel`, bo korzysta z jego kafelków, albo na `main` po zmergowaniu #73.
