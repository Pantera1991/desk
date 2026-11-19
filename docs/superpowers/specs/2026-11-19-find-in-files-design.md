# Szukaj w plikach (jak „Find in Files” w PhpStormie)

## Po co

Użytkownik pracuje na co dzień w PhpStormie i chce w desk tego samego szukania po treści plików
projektu. Ma działać tak: skrót, wpisanie tekstu, lista trafień z podglądem i Enter, który otwiera
plik na właściwej linii. Dziś panel plików ma tylko `?tekst` w filtrze drzewa, które zwraca same
nazwy plików, bez linii i bez podświetlenia.

## Cele

- Osobny skrót otwiera okienko szukania (popup na środku okna, jak w PhpStorm) dla projektu
  aktywnej karty.
- Trafienia pokazują się w trakcie pisania. Każde to linia z podświetlonymi fragmentami, a po prawej
  plik i numer linii.
- Pod listą jest podgląd zaznaczonego trafienia: plik przewinięty do tej linii, z podświetleniem.
- ↑/↓ chodzą po liście, a podgląd idzie za nimi. Enter otwiera plik na tej linii, Esc albo klik obok
  zamyka okienko.
- Enter (i dwuklik w drzewie) otwiera plik w edytorze wybranym w Opcjach: wbudowanym w panel albo
  zewnętrznym (np. `subl`).

## Czego nie robimy

- Zamiany (Replace in Files).
- Maski plików i wyboru katalogu (cały projekt).
- Szukania w plikach z `.gitignore` (np. `vendor`, `node_modules`). Zakres jak dziś przy `?tekst`.
- Historii wyszukiwań.
- Przypinania wyników.

## Czego nie wolno zepsuć

- Dzisiejsze `?tekst` w filtrze drzewa i zwykły filtr nazw działają jak dotąd.
- Szukanie nie może zamrozić okna ani zostawić procesu w tle. Ma limit czasu, a nowe zapytanie
  unieważnia stare.
- Zewnętrzny edytor dostaje plik jako argument programu, nigdy przez powłokę. Komenda z Opcji ma
  ścisły zestaw znaków.
- Plik spoza projektu nie da się otworzyć (to samo `project::inside` co dziś).

## Sposoby (wybrany: 1)

1. **`git grep` + pozycje trafień liczone w Rust (wybrany).** `git grep -n -I --untracked` z
   flagami. Rust wyznacza fragmenty do podświetlenia biblioteką `regex`. Jest już w drzewie
   zależności, a do `Cargo.toml` dochodzi tylko jako bezpośrednia (bez nowych crate'ów w `Cargo.lock`). Gdy projekt nie jest repozytorium, Rust przeszukuje pliki tymi samymi regułami.
   Szybkie, korzysta z tego, co już jest, i nie dokłada zależności.
2. **ripgrep, gdy jest zainstalowany.** Najszybszy, ale nie wszędzie jest, więc i tak trzeba
   wariantu 1. To dwie drogi do utrzymania. Odrzucony.
3. **Wszystko w Rust (biblioteka `ignore`).** Jeden silnik wszędzie, ale nowa zależność i więcej
   kodu przy podobnym efekcie. Odrzucony.

Wybrał użytkownik: 1.

## Jak działa

### Skrót

- `findInFiles`: macOS ⇧⌘F (`Super+Shift+KeyF`), Linux i Windows Ctrl+Alt+Shift+F
  (`Control+Alt+Shift+KeyF`). Ctrl+Shift+F jest zajęte przez panel plików. Wybrał użytkownik.
- Grupa `window`. W Opcjach → Skróty da się go zmienić jak inne.

### Okienko szukania (popup)

Najpierw był to tryb w panelu plików. Użytkownik zmienił to na popup na środku okna, jak w PhpStorm.

```
┌ Szukaj w plikach ───────────── [Aa] [W] [.*] ┐
│ pre                                          │
├──────────────────────────────────────────────┤
│▸title: [pre]view of the page  notes.md     2 │
│ $[pre]vious = $this->last();  Cart.php    76 │
├─ notes.md ───────────────────────────────────┤
│  2 title: [pre]view of the page              │
└──────────────────────────────────────────────┘
```

- **Otwieranie skrótem:** okienko (`.overlay`, jak paleta ⌘P) na środku, ok. 80% szerokości i 75%
  wysokości okna, nad kafelkami. Natywny podgląd stron w panelu jest wtedy ukryty, jak przy każdym
  okienku. Ponowny skrót daje fokus polu. Okienka nie da się przesuwać ani zmieniać jego rozmiaru.
- **Pole:** dostaje fokus. Gdy w terminalu albo edytorze był zaznaczony tekst w jednej linii, wpada
  on do pola.
- **Przełączniki:**
  - **Aa:** wielkość liter;
  - **W:** całe słowo;
  - **.\*:** wyrażenie regularne.

  Domyślnie wszystkie są wyłączone. Ostatni stan zostaje w localStorage.
- **Kiedy szuka:** 250 ms po ostatnim znaku i od razu po przełączniku. Pusty tekst czyści listę. Do
  wyniku trafia tylko odpowiedź na najnowsze zapytanie (licznik zapytań).
- **Nagłówek:** „N trafień w M plikach”, a przy obciętej liście „pokazano N, jest ich więcej” (N to liczba pokazanych; limit czasu może uciąć listę przed 500).
- **Wiersz listy:** treść linii przycięta do ok. 200 znaków wokół pierwszego trafienia (z „…”),
  trafienia podświetlone (`<mark>`), po prawej „plik linia” (sama nazwa pliku, pełna ścieżka w
  podpowiedzi). Zaznaczony wiersz jest wyróżniony.
- **Podgląd:** pod listą, w edytorze desk (CodeMirror) w trybie tylko do odczytu, z nazwą i ścieżką
  pliku nad nim. Linia trafienia jest przewinięta na środek i zaznaczona, a fragmenty podświetlone.
  Podgląd jest wczytywany przy zmianie zaznaczenia, z cache ostatniego pliku.
- **Klawisze:**
  - ↑/↓ (także z pola tekstowego) zmieniają zaznaczenie, PageUp/PageDown skaczą o stronę;
  - **Enter** otwiera plik zaznaczonego trafienia na jego linii;
  - **Esc** zamyka okienko i oddaje fokus temu, co go miało wcześniej (np. terminalowi).
- **Myszką:** klik zaznacza wiersz, dwuklik działa jak Enter, klik obok okienka działa jak Esc.
- **Błędy:** zły regex pokazuje komunikat pod polem zamiast listy. Najpierw sprawdza go Rust
  (`regex::Regex::new`), a jeśli tu przejdzie, a git zwróci błąd składni ERE, pokazujemy błąd gita
  (decyzja: Claude). Bez projektu: „Otwórz kartę
  projektu”.

### Szukanie (Rust)

- **Komenda:** `grep_files(path, query, case, word, regex) -> GrepResult` (async, `spawn_blocking`).
- **Wynik:** `GrepResult { hits: Vec<GrepHit>, files: u32, more: bool }`, gdzie
  `GrepHit { file: String /* względem projektu */, line: u32, text: String, marks: Vec<[u32; 2]> }`.
  `marks` to zakresy w `text` w jednostkach UTF-16 (pod JavaScript), już po przycięciu linii.
- **Repozytorium git:** `git --no-optional-locks -c core.fsmonitor=false grep -n -I --untracked
  --no-color --max-count=50` z flagami:
  - `-i`, gdy wielkość liter jest wyłączona;
  - `-w`, gdy szukamy całego słowa;
  - `-E` przy wyrażeniu regularnym, inaczej `-F`;
  - `-e <tekst>`.

  Limit czasu to 5 s (`proc::run`). Po przekroczeniu zwracamy błąd „szukanie trwało za długo”.
- **Projekt bez gita:** te same pliki, co dzisiejsze `?tekst` w tym przypadku, czyli lista
  `project::files`:
  - wpisy folderów (`nazwa/`) są pomijane;
  - pliki ponad 1 MB są pomijane (rozmiar z `metadata`);
  - tekst to plik, który da się przeczytać jako UTF-8 i nie ma bajtu NUL w pierwszych 8 KB;
  - szukanie idzie linia po linii.

  Poza gitem `project::files` i tak omija `node_modules`, `target` i podobne (decyzja: Claude).
- **Podświetlanie:** Rust buduje `regex::Regex` z tych samych ustawień i oznacza w każdej linii
  wszystkie dopasowania:
  - zwykły tekst przechodzi przez `regex::escape`;
  - całe słowo jak w `git grep -w`: przed trafieniem i po nim nie ma znaku słowa (litery, cyfry, `_`), więc `$zmienna` też się liczy;
  - brak wielkości liter to `(?i)`.

  Gdy składnia regexu w gicie (ERE) i w Rust się rozjedzie i linia nie ma żadnego dopasowania, i tak
  zostaje na liście, tylko bez podświetlenia.
- **Limity:** najwyżej 50 trafień w jednym pliku (`--max-count`, poza gitem to samo w pętli). Potem
  cała lista jest obcinana do 500. Przy obcięciu `more = true`.
- **Podgląd:** czyta plik osobną komendą tylko do odczytu `read_project_text(path, file)`: plik musi leżeć w projekcie, mieć do 1 MB i nie być binarny. `api.readText` czyta tylko pliki już otwarte w panelu, więc się nie nadaje.

### Otwieranie pliku: Opcje → „Edytor plików”

- **Pole w `layout.json`:** `fileEditor: string`, także w Rust `Layout`. Domyślnie `""` oznacza
  edytor wbudowany. Stare pliki bez pola dostają edytor wbudowany.
- **Opcje → Projekty** (albo Terminal i linki, wybór budującego): „Edytor plików”. Wybór
  „Wbudowany” albo „Program”, z polem na komendę, np. `subl`, `code`, `phpstorm` albo pełną
  ścieżką. Znaki dozwolone w komendzie: litery, cyfry i `/._-~` (bez spacji i bez argumentów).
  Ścieżki ze spacją, np. aplikacje macOS, nie przejdą; wtedy trzeba podać komendę z PATH
  (decyzja: Claude). Rust rozwija `~/` i szuka programu (`agents::which` albo plik wykonywalny pod
  ścieżką bezwzględną):
  - przy zapisie w Opcjach nieznaleziony program blokuje zapis z komunikatem pod polem, jak przy
    serwerach Dockera;
  - przy otwieraniu pliku pokazujemy błąd w powiadomieniu.

  Rodzinę edytora rozpoznajemy po nazwie pliku programu (`~/bin/subl` to `subl`). Decyzja: Claude.
- **Opcje → Terminal i linki**: tam trafia „Edytor plików” (decyzja: Claude).
- **Wbudowany:** plik otwiera się w edytowalnym edytorze panelu plików, tym samym, który dziś
  otwiera przycisk ✎ w nagłówku panelu (`side.ts`: `edit()`, `editing`, zapis przyciskiem i
  ⌘S/Ctrl+S). Kursor stoi na linii trafienia, przewiniętej na środek.
- **Zewnętrzny:** nowa komenda Rust `open_file_at(path, file, line)`. Sprawdza `project::inside`,
  bierze komendę z `layout.fileEditor` i uruchamia ją bez powłoki, z argumentami zależnymi od
  nazwy programu:
  - `subl`, `zed`: `plik:linia`;
  - `code`, `cursor`, `codium`: `--goto plik:linia`;
  - `phpstorm`, `idea`, `webstorm`, `pycharm`, `goland`, `rider`, `clion`: `--line N plik`;
  - inne: sam `plik`.
- **Dwuklik w drzewie** otwiera plik według tego samego ustawienia. Dziś dwuklik zgaduje zewnętrzny
  edytor (`code`/`cursor`/`zed`/`subl`/systemowy). Przy domyślnym „Wbudowany” otworzy edytor
  panelu, a tę zmianę zachowania użytkownik zaakceptował. Zewnętrzny edytor uruchamia tylko
  `open_file_at`. Stare `open_file` ze zgadywaniem nie miało już innych wywołań, więc
  zostało usunięte. Programy, które uruchomiłyby plik zamiast go otworzyć (powłoki, interpretery,
  `rm` i podobne), Opcje odrzucają.

### Kod

- **Rust:**
  - `src-tauri/src/grep.rs`: szukanie, podświetlanie, przycinanie linii, limity, plus testy;
  - `project.rs`: `open_file_at` przy `open_in_editor`;
  - `layout.rs`: `file_editor`;
  - `lib.rs`: komendy i rejestracja (`generate_handler!`, `build.rs`, `capabilities/default.json`).
- **TS:**
  - `src/find-view.ts`: czyste funkcje (HTML wierszy z `<mark>`, nagłówek, ruch zaznaczenia);
  - `src/find-panel.ts`: okienko szukania (popup), czyli pole, lista, podgląd i klawisze;
  - zmiany w `side.ts` (otwarcie okienka, otwarcie pliku na linii),
    `editor.ts` (tylko do odczytu i przejście do linii z podświetleniem), `keys.ts`, `app.ts`,
    `settings.ts`, `api.ts`, `pl.ts`/`en.ts`, `styles.css` (rozmiary przez `--ui-scale`).

## Testy

- **Rust:**
  - git i bez gita;
  - przełączniki Aa / W / .\*;
  - zły regex;
  - zakresy UTF-16 przy polskich znakach i emoji;
  - przycinanie długiej linii;
  - limity 500 i 50;
  - pliki binarne pominięte;
  - plik z `.gitignore` pominięty, a nowy niezacommitowany znaleziony;
  - zapytanie zaczynające się od `-` traktowane jako tekst;
  - argumenty `open_file_at` dla każdej rodziny edytorów;
  - komenda ze spacją lub `;` odrzucona;
  - plik spoza projektu odrzucony;
  - zapis i odczyt `fileEditor`.
- **TS:**
  - HTML wiersza (escapowanie, `<mark>` w dobrych miejscach);
  - ruch zaznaczenia na brzegach;
  - nagłówek z `more`;
  - odrzucanie starych odpowiedzi;
  - skrót w `keys.test.ts`.
- **Ręcznie:**
  - szukanie w dużym repozytorium PHP;
  - Enter w edytorze wbudowanym i w `subl`;
  - Esc i klik obok zamykają okienko, a fokus wraca do terminala;
  - natywny podgląd strony nie przykrywa okienka.

## Zostawione budującemu

- Zakładka Opcji dla „Edytor plików”.
- Dokładne teksty pl/en.
- Wysokość listy względem podglądu (np. 40/60 z możliwością przeciągnięcia albo stała).
- Wygląd przełączników.
