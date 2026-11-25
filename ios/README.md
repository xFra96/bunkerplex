# BunkerPlex per iPhone e iPad

L'app si compila su GitHub (giro "Pubblica l'app iOS") e si scarica dalle
release `ios-v…` come `BunkerPlex.ipa`. Non è firmata: la firma chi la installa.

## Installare da Windows (gratis)

1. Installa iTunes e iCloud presi dal sito Apple (non dal Microsoft Store) e
   [Sideloadly](https://sideloadly.io).
2. Collega l'iPhone con il cavo e sblocca; trascina `BunkerPlex.ipa` in Sideloadly,
   scrivi il tuo Apple ID e premi Start.
3. Sull'iPhone: Impostazioni → Generali → VPN e gestione dispositivi → fidati del
   tuo Apple ID. Da iOS 16 attiva anche Impostazioni → Privacy e sicurezza →
   Modalità sviluppatore.
4. Al primo avvio consenti "Rete locale": serve per trovare il PC di casa.

Con un Apple ID gratuito la firma dura 7 giorni: Sideloadly la rinnova da solo
se lasci acceso il PC con l'iPhone sulla stessa rete (opzione "Auto refresh").

## Cosa fa

- In casa apre BunkerPlex del PC (stessa interfaccia del browser, video in HLS
  con AirPlay e picture-in-picture).
- Fuori casa entra con l'account e raggiunge i tuoi PC e quelli degli amici con
  il Tailscale dentro l'app (stessa libreria dell'app Android, `android/tsnet`).
