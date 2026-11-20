# Panel plików w osobnym oknie

## Po co

Użytkownik chce móc trzymać panel plików (drzewo, edytor, podgląd stron) w osobnym oknie
systemowym zamiast z boku okna desk. Wybrał wariant „cały panel” (B), a nie sam podgląd (A).
Okno można przesunąć na drugi monitor i powiększyć, a główne okno ma kafelki na całą szerokość.

## Cele

- Opcje → Okno i układ: „Panel plików: z boku | w osobnym oknie”. Domyślnie „z boku” (jak dziś).
  Zmiana działa od razu, bez restartu.
- W trybie „w osobnym oknie” panel żyje w oknie „desk — pliki” i ma wszystko, co dziś:
  drzewo z filtrem, pasek adresu z ‹ › ⟳, edytor plików (✎, zapis), karty folderów, podgląd stron
  i dokumentów (natywny widok `preview`), przyciski @, ↗, ☰, ×.
- Okno idzie za aktywnym kafelkiem głównego okna (ten sam projekt co dziś `follow`).
- Wszystko, co dziś otwiera panel, otwiera albo wysuwa okno i pokazuje w nim plik lub stronę:
  ⌘F (pliki), ⌘W (podgląd), ikona folderu na górnym pasku, przycisk 🌐, klik w link w terminalu,
  ⌥↵ / „otwórz plik” z kafelka, Enter w okienku „Szukaj w plikach”, dwuklik w drzewie.
- Zamknięcie okna (× okna albo × panelu) to zamknięcie panelu; desk działa dalej.
- „@” wpisuje do aktywnej sesji głównego okna; „terminal tutaj” otwiera kafelek w głównym oknie.
- Okienko „Szukaj w plikach” zostaje w głównym oknie; trafienie otwiera się w oknie plików.
- Zmiany w Opcjach (język, motyw, rozmiar interfejsu, edytor plików, przeglądarka, klik w link)
  od razu działają w oknie plików.
- Skróty w oknie plików: panelowe (⌘S w edytorze, ⌘F, ⌘W, Esc). Reszta skrótów desk działa
  tylko w głównym oknie.
- Okno zapamiętuje miejsce i rozmiar (jak główne okno, osobny plik obok `window.json`).

## Czego nie robimy

- Kilku okien plików naraz.
- Przenoszenia okienka „Szukaj w plikach” do okna plików.
- Kafelków ani terminali w oknie plików.
- Panelu Docker / rsync w osobnym oknie.

## Czego nie wolno zepsuć

- Tryb „z boku” działa dokładnie jak dziś (domyślny).
- Blokada desk (kłódka, `lock_desk`): okno plików jest wtedy schowane i nie da się go pokazać do
  odblokowania. Inaczej pliki byłyby widoczne mimo blokady.
- Podgląd stron dalej ładuje niezaufane treści: nie dostaje żadnych komend desk, niezależnie od
  okna, w którym jest.
- Okno plików ładuje tylko stronę desk i dostaje tylko komendy potrzebne panelowi (osobna
  capability dla jego etykiety), nie wszystkie komendy głównego okna (np. `pty_write`, `quit_desk`).
- Tryb rozwijany z góry ekranu (dropdown) dotyczy tylko głównego okna.

## Sposoby (wybrany: 1)

1. **Drugie okno Tauri z tą samą aplikacją w trybie „tylko panel” (wybrany).** Okno `files` ładuje
   ten sam bundle z innym punktem wejścia (np. `index.html?files` albo `files.html`), które tworzy
   samo `Side`. Główne okno ma w tym trybie zastępcę panelu, który przekazuje wywołania do okna
   plików zdarzeniami Tauri, a okno plików odsyła zdarzeniami to, czego potrzebuje od głównego
   (aktywny projekt, wpisanie do sesji, terminal, ustawienia). Jedyny wykonalny: elementów strony
   nie da się przenieść między oknami.
2. **Przeniesienie panelu do okna przez wspólny stan w Rust.** Ten sam efekt, ale stan panelu
   musiałby zamieszkać w Rust; dużo więcej kodu. Odrzucony.
3. **Sam podgląd w osobnym oknie (A).** Odrzucony przez użytkownika.

## Jak działa

### Tryb i przełączanie

- `layout.filesWindow: boolean` (Rust `files_window`, domyślnie false).
- Włączenie: panel z boku się zamyka; jeśli był otwarty, okno plików otwiera się z tym samym
  widokiem (ten sam plik albo strona). Wyłączenie: okno plików się zamyka; jeśli było otwarte,
  panel z boku otwiera się z tym samym widokiem.

### Okno plików

- Etykieta `files`, tytuł „desk — pliki”, zwykła ramka systemu, tło jak główne okno.
- Tworzy je Rust na żądanie (komenda), nie przy starcie; przy starcie desk okno jest zamknięte
  (jak panel dziś).
- Strona okna: ten sam `Side` co dziś, wypełniający całe okno (bez splittera), z kontekstem, który
  rozmawia z głównym oknem przez zdarzenia.
- Natywny podgląd `preview` jest dzieckiem tego okna, gdy panel jest w oknie plików, a dzieckiem
  głównego okna w trybie „z boku”. Zdarzenia `preview-login` / `preview-url` idą do okna, w którym
  jest panel.
- Miejsce i rozmiar: zapisywane jak główne okno, w osobnym pliku.

### Rozmowa okien

- Główne → okno plików: otwórz pliki (⌘F), przełącz podgląd (⌘W), przeglądarka (🌐), otwórz
  link / plik projektu, otwórz plik na linii (szukanie), zmiana aktywnego projektu, zmiana ustawień,
  blokada / odblokowanie.
- Okno plików → główne: wpisz tekst do aktywnej sesji (@), terminal w folderze, okno zamknięte
  (ikona folderu na pasku przestaje być wciśnięta), panel pokazuje pliki (stan ikony).
- Aktywny projekt i ustawienia okno plików czyta przy starcie (bootstrap jest tylko do odczytu)
  i dostaje potem zdarzeniami.

### Skróty

- W oknie plików: ⌘S zapisuje w edytorze, ⌘F pokazuje drzewo, ⌘W zamyka okno, Esc jak dziś w panelu.
- ⇧⌘F w oknie plików: przełącza na główne okno i otwiera tam „Szukaj w plikach”.
- Inne skróty desk w oknie plików nie robią nic.

## Testy

- **TS:** wybór trybu (z boku / okno) w zastępcy panelu; mapowanie wywołań na zdarzenia i z
  powrotem; skróty okna plików; Opcje: przełącznik zapisuje `filesWindow`.
- **Rust:** `files_window` w layout (domyślnie false, zapis/odczyt); capability okna `files`
  zawiera komendy panelu i nie zawiera np. `pty_write` ani `quit_desk` (test w stylu
  `the_main_window_can_call_every_registered_command`); miejsce okna zapisywane w osobnym pliku.
- **Ręcznie:** przełączanie w obie strony z otwartym plikiem i stroną; ⌘F, ⌘W, ikona, link z
  terminala, Enter w szukaniu; @ i terminal tutaj; zmiana języka i motywu; blokada desk chowa okno;
  zamknięcie okna; restart desk w trybie okna (okno zamknięte, ⌘F je otwiera w zapamiętanym
  miejscu); drugi monitor.

## Decyzje po przeglądzie budującego (decyzje: Claude)

- **Podgląd przy zmianie trybu:** natywnego widoku nie da się przenieść do innego okna, więc
  zostaje zamknięty i stworzony od nowa w nowym oknie z ostatnim adresem. Przewinięcie, logowanie
  na stronie i historia ‹ › przepadają.
- **Start desk:** okno plików zawsze startuje zamknięte, tak jak panel dziś. Zapamiętany jest tylko
  tryb (`filesWindow`), nie to, czy okno było otwarte. Stan ikony folderu główne okno zna ze
  zdarzeń okna plików (otwarte / zamknięte / pokazuje pliki).
- **Wywołania asynchroniczne:** zastępca panelu w głównym oknie niczego nie czeka. `preview()` i
  `previewFile()` w trybie okna wysyłają żądanie i kończą się od razu, a błąd pokazuje okno plików.
  Dopóki okno plików nie zgłosi gotowości, zastępca trzyma żądania w kolejce i wysyła je po
  zgłoszeniu. `isOpen` / `filesShown` zastępca bierze z ostatniego stanu zgłoszonego przez okno.
- **Ustawienia i projekt w oknie plików:** okno trzyma lokalną kopię (projekt, przeglądarka, klik w
  link, edytor plików, język, motyw, rozmiar), wypełnianą przy starcie z `bootstrap` i
  aktualizowaną zdarzeniami. Gettery `SideContext` zostają synchroniczne.
- **Blokada:** pilnuje jej Rust. `lock_desk` chowa okno plików (z podglądem w nim), a komenda,
  która pokazuje albo tworzy okno plików, odmawia, dopóki desk jest zablokowany. Po odblokowaniu
  okno wraca, jeśli było otwarte przed blokadą.
- **Lista komend okna plików:** wynika z tego, czego używają `side.ts`, drzewo plików i edytor
  (podgląd, odczyt i zapis plików, pliki projektu, git, ujawnienie w systemie, otwieranie na zewnątrz,
  edytor plików, komendy okna plików). Test Rust sprawdza, że jest tam każda z nich i nie ma
  `pty_write`, `quit_desk` ani `save_layout`.
- **Miejsce okna:** ta sama logika co główne okno (`window_place.rs`), łącznie z pominięciem miejsca
  na odłączonym monitorze.

## Zostawione budującemu

- Punkt wejścia strony okna plików (`files.html` z własnym `files-main.ts` albo parametr w URL).
- Dokładne nazwy zdarzeń i komend.
- Jak zastępca panelu w głównym oknie wygląda w kodzie (osobna klasa z tym samym interfejsem co
  `Side`, którego używa `app.ts`, albo `Side` z trybem zdalnym).
- Czy okno plików ma własny CSS, czy ten sam `styles.css` z klasą na `body`.
