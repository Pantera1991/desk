# Awaryjne zatrzymanie patrzy na najgorętszy czujnik

## Po co

Awaryjne zatrzymanie (PR 52, wydane w desk 0.2.0) zamraża pracę
w sesjach, gdy średnia z 15 s dojdzie do progu (domyślnie 95°C). Czyta tę samą temperaturę co pasek,
zwalnianie i wiatraki: najwyższy z czujników `PMU tdie*` przez IOHID.

Właściciel porównuje desk ze Stats i chce, żeby zatrzymanie było **pesymistyczne**: lepiej zatrzymać
za wcześnie niż przegrzać laptopa. Pomiar na M3 Pro (sonda tylko do odczytu; odczyt jak desk
i „Hottest CPU” jak Stats, który ma wyłączone czujniki HID i czyta SMC; 11× `yes` przez 50 s):

| moment | desk | Stats | różnica |
|---|---|---|---|
| spoczynek | 49,0 | 54,3 | +5 |
| po 15 s obciążenia | 51,9 | 64,3 | +12 |
| po 45 s | 54,6 | 67,7 | +13 |
| 3 s po zdjęciu obciążenia | 52,7 | 59,7 | +7 |

- Odczyt desk jest niższy i wolniejszy: +5,6°C w 50 s, gdy Stats +13°C (+7°C w pierwszych 3 s).
  Różnica rośnie z obciążeniem; na prawdziwym buildzie doszła do +25°C (sekcja „Pomiar na buildzie”).
- Próg 95°C na tym czujniku prawdopodobnie nigdy nie zadziała: rdzenie byłyby wtedy dużo wyżej,
  a macOS dławi procesor wcześniej. Zatrzymanie daje dziś fałszywe poczucie ochrony.
- Zatrzymanie pomija stan termiczny macOS (zwalnianie i wiatraki biorą „serious”).

## Cele

- Zatrzymanie porównuje z progiem **najgorętszy odczyt**: maksimum z czujników rdzeni w SMC (te same
  klucze co Stats dla danej generacji układu) i obecnego czujnika desk (`PMU tdie*`). Nigdy nie jest
  bardziej optymistyczne niż desk ani niż Stats.
- **Krytyczny stan termiczny macOS** (`NSProcessInfoThermalState::Critical`) zatrzymuje od razu,
  bez średniej, i blokuje Wznów, dopóki trwa.
- Wznów jak dziś: dopiero gdy średnia najgorętszego odczytu zejdzie 5°C pod próg (i macOS nie jest
  w stanie krytycznym).
- Domyślny próg **90°C** zamiast 95°C (zakres 60–110 bez zmian), w TS i w Rust. Uzasadnienie
  w „Pomiar na buildzie”.
- Widać, na co patrzy zatrzymanie: podpowiedź chipu, toast/powiadomienie po zatrzymaniu i odmowa
  wznowienia podają najgorętszy odczyt, nie liczbę z chipu.
- Opcje mówią, czego zatrzymanie pilnuje na tym komputerze, i ostrzegają, gdy nie ma czego.

## Pomiar na buildzie

Pełny `cargo build --release` desk (LTO, osobny katalog `target`, 2 min 07 s) na M3 Pro, odczyt co
3 s, wiatraki w trybie właściciela (stopnie od 50°C wg czujnika desk):

| | czujnik desk | Stats („Hottest CPU”) | wszystkie `Te*` |
|---|---|---|---|
| szczyt (pojedynczy odczyt) | 56,2 | 81,4 | 85,2 |
| szczyt średniej z 15 s | 55,0 | 79,3 | 84,1 |

- Różnica desk–Stats doszła do **+25°C**; stan termiczny macOS cały czas „nominal”.
- Wniosek dla progu: ciężki, ale typowy build to ~80°C na najgorętszym odczycie. 90°C daje 10°C
  zapasu na zwykłą pracę i zatrzymuje, zanim zrobi się naprawdę gorąco; klucze Stats na M3 Pro
  widzą tylko rdzenie energooszczędne, więc rzeczywisty szczyt jest raczej wyżej niż odczyt, co
  przemawia za niższym progiem. Dłuższego obciążenia (kilku agentów naraz przez kwadrans) nie
  mierzono.
- Uboczna obserwacja dla kierunku C: zwalnianie od 80°C i stopnie wiatraków patrzą na czujnik desk,
  który w tym buildzie nie przekroczył 56°C, gdy rdzenie miały 81°C.

## Czego nie robimy

- Nie zmieniamy liczby w chipie, zwalniania ani wiatraków: dalej `PMU tdie*` (kierunek C, odłożony;
  linia z najgorętszym odczytem w podpowiedzi da dane do tej decyzji później).
- Nie doliczamy stałego zapasu do odczytu (kierunek A, odrzucony niżej).
- Nie zgadujemy znaczenia kluczy SMC spoza listy Stats (np. `Tp*` na M3, które w spoczynku pokazują
  60–81°C): fałszywe zatrzymanie zamraża całą pracę do ręcznego wznowienia.
- Linux i Windows bez zmian (już czytają czujniki procesora; stanu termicznego systemu nie mają).

## Czego nie wolno zepsuć (anty-cele)

- Zatrzymanie dalej domyślnie wyłączone. Przy wyłączonym nic się nie zmienia (żadnej nowej linii
  w podpowiedzi, żadnego ostrzeżenia).
- Pojedynczy skok nie zatrzymuje: czujniki rdzeni skaczą o ±7°C w 3 s, więc średnia z 15 s zostaje.
- Nic, co działało (zamrażanie, Wznów, `halted-pids` po awarii, plan zamrożenia), się nie zmienia.
- Odczyt SMC nie wymaga uprawnień ani helpera `desk-fans` (sam odczyt, jak dziś odczyt wiatraków).

## Podejścia

- **A. Zapas doliczany do odczytu** (np. +15°C albo niższy próg). Kilka linijek, każdy system. Ale
  różnica nie jest stała (5→13°C i rośnie), odczyt dalej się spóźnia, każdy Mac ma inną; liczba
  w pasku nie zgadza się z progiem. Odrzucone.
- **B. Zatrzymanie bierze najgorętsze źródło, reszta bez zmian.** Pesymistyczne z założenia, naprawia
  część krytyczną dla bezpieczeństwa, nie rusza dostrojonych progów zwalniania i wiatraków
  (u właściciela: zwalnianie od 80°C, wiatraki od 50°C). Koszt: dwie liczby w desk, lista kluczy na
  generację. **Wybrane przez właściciela.**
- **C. Jeden pesymistyczny odczyt wszędzie.** Jedna liczba zgodna ze Stats, ale zwalnianie i wiatraki
  ruszałyby dużo wcześniej i trzeba by je przestroić. Odłożone.

## Projekt

### Odczyt (thermal.rs, macOS)

- Co tick (5 s) obok obecnego odczytu: `cores`, najwyższy wiarygodny (`hottest`, 1–130°C) odczyt
  z kluczy SMC rdzeni tej generacji, które istnieją i mają typ `flt `. Brak SMC, nieznana generacja,
  żaden klucz: `None`.
- Generacja z `machdep.cpu.brand_string` („Apple M3 Pro” → M3). Listy kluczy przepisane z Stats
  (`Modules/Sensors/values.swift`, MIT, w źródle komentarz skąd): M1, M2, M3, M4, M5, M6, A18 Pro,
  tylko wpisy `group: .CPU`, `type: .temperature`, `average: true`. Na M3 Pro istnieją z nich tylko
  `Te05`, `Te0P`, `Te0S` (czujniki rdzeni energooszczędnych); tyle samo widzi Stats.
- Intel Mac: brak `PMU tdie*` i listy, więc `cores` = `None`; zostaje stan krytyczny macOS.
- Stan systemu: obok `pressure()` (serious lub gorzej, dla zwalniania i wiatraków) osobno
  `critical()` (tylko critical, dla zatrzymania). Linux/Windows: `false`.

### Decyzja (Halt)

- Na wejściu odczyt dla zatrzymania = `max(celsius, cores)` (gdy jedno `None`, drugie; oba `None`:
  bez odczytu, jak dziś) i `critical`.
- Średnia z 3 takich odczytów ≥ próg → zatrzymane. `critical` → zatrzymane od razu.
- `resume` odmawia, gdy średnia > próg − 5°C albo trwa `critical`; w odmowie wiadomo, co blokuje.
- Bez zmian: trzyma się aż do Wznów, wyłączenie opcji puszcza.

### Status (do frontu)

- `hottest`: najgorętszy odczyt, na który patrzy zatrzymanie (zaokrąglony); tylko przy włączonym
  zatrzymaniu, inaczej `null`.
- `cores`: sam odczyt rdzeni z SMC (zaokrąglony); tylko przy włączonym zatrzymaniu na macOS, gdy jest,
  inaczej `null`. Obok `celsius` daje obie liczby do podpowiedzi (dane do decyzji o kierunku C).
- `haltedBy`: `"temperature"` albo `"system"` (stan krytyczny macOS), gdy `halted`.
- Co zatrzymanie widzi na tym komputerze, pięć stanów:
  1. rdzenie, czujnik desk i stan macOS (Apple Silicon znanej generacji),
  2. czujnik desk i stan macOS (Apple Silicon nieznanej generacji),
  3. tylko stan macOS (Intel Mac),
  4. czujnik procesora (Linux, Windows z odczytem; to już czujniki rdzeni, bez ostrzeżenia),
  5. nic (Linux, Windows bez odczytu).
  Kształt pola zostawiony builderowi.

### Wygląd

- **Podpowiedź chipu** (zatrzymanie włączone): linia z obiema liczbami, nie z etykietą źródła,
  np. „Awaryjne zatrzymanie od 90°C: rdzenie 68°C, czujnik desk 54°C.” Bez odczytu rdzeni (stany
  2–4): „Awaryjne zatrzymanie od 90°C: procesor 54°C.” Gdy zatrzymane: jak dziś, plus co je wywołało.
- **Toast i powiadomienie** po zatrzymaniu: najgorętszy odczyt zamiast liczby z chipu; przy stanie
  krytycznym „macOS zgłosił krytyczną temperaturę”.
- **Odmowa Wznów**: najgorętsza średnia albo „macOS wciąż zgłasza krytyczną temperaturę”.
- **Opcje → Temperatura i kawa**, opis pod zatrzymaniem zależny od stanu „co widzi”:
  1. najgorętszy z czujników rdzeni (jak Stats) i czujnika desk, oraz krytyczny stan macOS;
  2. ostrzeżenie „rdzeni tego procesora desk jeszcze nie zna: patrzy na swój czujnik i stan macOS”;
  3. ostrzeżenie „desk nie odczytuje tu temperatury: zatrzyma tylko, gdy macOS zgłosi krytyczną”;
  4. czujnik procesora (jak dziś, bez ostrzeżenia i bez wzmianki o macOS);
  5. ostrzeżenie „desk nie odczytuje tu temperatury, zatrzymanie nie zadziała”.
- Chip, panel procesora, kolory: bez zmian.

### README

Akapit „Awaryjne zatrzymanie” i uwaga techniczna: skąd odczyt (SMC rdzeni jak Stats + IOHID,
maksimum), stan krytyczny macOS, Intel i Linux/Windows.

## Testy

- Halt: trzyma się średniej z maksimum źródeł; skok w jednym źródle nie zatrzymuje; `critical`
  zatrzymuje od razu i blokuje Wznów; `cores` = `None` → sam czujnik desk.
- Generacja z napisu procesora; nieznany („Apple M9”, Intel) → pusta lista.
- `cores` na atrapie SMC (wzorem `FakeSmc` z fan_control.rs): brakujące klucze i nonsensowne wartości
  pomijane.
- Front: linia w podpowiedzi tylko przy włączonym zatrzymaniu; toast z `hottest`; ostrzeżenia w
  Opcjach dla każdego „co widzi”.
- `#[ignore]` test na żywym Macu: wypisuje czujnik desk, `cores` i stan systemu (jak
  `reads_this_computer`).

## Ograniczenia

- Na M3 Pro lista Stats obejmuje tylko czujniki rdzeni energooszczędnych; rdzeni wydajnych Stats tu
  nie widzi (jego klucze `Tf04…Tf4E` na M3 Pro nie istnieją). Inne klucze `Te*` pokazują o 5–8°C
  więcej, ale ich znaczenie jest niepewne.
- Powyżej ~80°C (Stats) różnicy nie mierzono; dłuższego obciążenia też nie.
- Nowa generacja układu wymaga dopisania listy (do tego czasu: czujnik desk i stan macOS).

## Decyzje właściciela (2026-11-15)

- Lista kluczy dokładnie jak w Stats, bez innych `Te*` (ostrożność ustawia próg, nie klucze
  o nieznanym znaczeniu).
- Tylko stan „critical” zatrzymuje od razu; „serious” nie (to robota zwalniania i wiatraków).
- Domyślny próg: po pomiarze na prawdziwym ciężkim buildzie (sekcja „Pomiar na buildzie”).

## Decyzje podjęte przy spisywaniu (do sprawdzenia przez właściciela)

- Domyślny próg 90°C (z pomiaru; ustawienie właściciela, gdy już jest w `layout.json`, zostaje).
- Linia z najgorętszym odczytem tylko przy włączonym zatrzymaniu.
- Podpowiedź pokazuje obie liczby (rdzenie i czujnik desk) zamiast etykiety źródła: prościej i od
  razu daje dane do decyzji o kierunku C.
- Linux i Windows z odczytem: osobny stan „czujnik procesora”, bez ostrzeżeń i bez tekstów o macOS.

## Zostawione builderowi

- Czy SMC czytać tylko przy włączonym zatrzymaniu, czy zawsze (kilka kluczy co 5 s).
- Kształt pola „co widzi” w statusie i podział kodu (np. lista kluczy w osobnym module).
- Dokładne brzmienie tekstów (pl i en), w tonie istniejących.
