// Package bpnet: Tailscale dentro l'app BunkerPlex del telefono.
//
// Fuori casa il telefono non vede i PC di BunkerPlex: stanno nella rete Tailscale di
// BunkerPlex (etichetta tag:bunkerplex) e rispondono solo sulla porta 32501, in
// HTTPS con un certificato loro. Questa libreria fa entrare l'app in quella rete
// (con una chiave monouso che l'app chiede al servizio account; il telefono e' un
// dispositivo temporaneo, che sparisce da solo quando l'app si spegne) e apre in
// 127.0.0.1 un piccolo proxy: l'app chiede
//
//	http://127.0.0.1:PORTA/<segreto>/<host:porta>/<impronta>/api/share/...
//
// e il proxy gira la richiesta a https://<host:porta>/api/share/... passando da
// Tailscale, solo se il certificato del PC ha proprio quell'impronta (SHA-256 del
// certificato, la stessa che il PC pubblica nel servizio account). Cosi' la pagina
// dell'app e il player parlano in HTTP semplice con il telefono stesso, e fuori dal
// telefono passa solo traffico cifrato verso i PC giusti.
//
// Si compila con gomobile (vedi build.sh): da Kotlin si usa bpnet.Bpnet.start(...).
package bpnet

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wlynxg/anet"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
)

var (
	mu      sync.Mutex
	srv     *tsnet.Server
	ln      net.Listener
	secret  string
	lastErr string
	lastLog []string

	transports sync.Map // impronta -> *http.Transport
	tokens     sync.Map // host:porta -> gettone dell'amico (X-Share-Token)
)

// SetToken: il gettone con cui si entra nel PC host:porta. Il proxy lo aggiunge da
// solo a ogni richiesta verso quel PC: cosi' anche immagini e video (che non possono
// mandare intestazioni) passano. Vuoto = lo si dimentica.
func SetToken(hostport, token string) {
	if token == "" {
		tokens.Delete(hostport)
	} else {
		tokens.Store(hostport, token)
	}
}

func init() {
	// Da Android 11 le app non possono leggere le interfacce di rete con netlink
	// (quello che fa Go di suo): si usa anet, che passa da un'altra strada.
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		ifs, err := anet.Interfaces()
		if err != nil {
			return nil, err
		}
		out := make([]netmon.Interface, 0, len(ifs))
		for i := range ifs {
			ifc := ifs[i]
			addrs, _ := anet.InterfaceAddrsByInterface(&ifc)
			out = append(out, netmon.Interface{Interface: &ifc, AltAddrs: addrs})
		}
		return out, nil
	})
}

func logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	mu.Lock()
	lastLog = append(lastLog, line)
	if len(lastLog) > 200 {
		lastLog = lastLog[len(lastLog)-200:]
	}
	mu.Unlock()
}

// Start fa entrare l'app nella rete di BunkerPlex e accende il proxy. dir e' una
// cartella dell'app (lo stato di Tailscale), key la chiave monouso del servizio
// account (vuota se lo stato salvato basta ancora). Restituisce "" se e' andato
// tutto bene, se no il motivo. Se e' gia' acceso non fa niente.
func Start(dir, key, hostname string) string {
	mu.Lock()
	if srv != nil && ln != nil {
		mu.Unlock()
		return ""
	}
	mu.Unlock()

	// Su Android non c'e' $HOME: Tailscale cerca li' la cache. E niente log mandati fuori.
	if os.Getenv("HOME") == "" {
		os.Setenv("HOME", dir)
	}
	os.Setenv("TS_LOGS_DIR", dir)
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	s := &tsnet.Server{
		Dir:       dir,
		Hostname:  hostname,
		AuthKey:   key,
		Ephemeral: true,
		Logf:      logf,
		UserLogf:  logf,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := s.Up(ctx); err != nil {
		s.Close()
		return fail("Tailscale non parte: " + err.Error())
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.Close()
		return fail("proxy: " + err.Error())
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)

	mu.Lock()
	srv, ln, secret, lastErr = s, l, hex.EncodeToString(b), ""
	mu.Unlock()
	go func() { _ = http.Serve(l, handler()) }()
	return ""
}

func fail(msg string) string {
	mu.Lock()
	lastErr = msg
	mu.Unlock()
	return msg
}

// Base: l'inizio degli indirizzi del proxy, "http://127.0.0.1:PORTA/<segreto>"
// ("" se spento).
func Base() string {
	mu.Lock()
	defer mu.Unlock()
	if ln == nil {
		return ""
	}
	return "http://" + ln.Addr().String() + "/" + secret
}

// IP: l'indirizzo 100.x del telefono nella rete di BunkerPlex ("" se spento).
func IP() string {
	mu.Lock()
	s := srv
	mu.Unlock()
	if s == nil {
		return ""
	}
	v4, _ := s.TailscaleIPs()
	if !v4.IsValid() {
		return ""
	}
	return v4.String()
}

// LastError e Log: per capire cosa non va (Impostazioni -> Questo dispositivo).
func LastError() string {
	mu.Lock()
	defer mu.Unlock()
	return lastErr
}

func Log() string {
	mu.Lock()
	defer mu.Unlock()
	return strings.Join(lastLog, "\n")
}

// Stop spegne tutto: il telefono esce dalla rete (ed essendo temporaneo sparisce).
func Stop() {
	mu.Lock()
	s, l := srv, ln
	srv, ln = nil, nil
	mu.Unlock()
	if l != nil {
		l.Close()
	}
	if s != nil {
		s.Close()
	}
	transports.Range(func(k, v any) bool {
		v.(*http.Transport).CloseIdleConnections()
		transports.Delete(k)
		return true
	})
}

var (
	pinRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	hostRe = regexp.MustCompile(`^[0-9A-Za-z.\-]{1,200}:[0-9]{1,5}$`)
)

// Un trasporto per impronta: accetta solo il certificato con quell'impronta.
func transportFor(pin string) *http.Transport {
	if t, ok := transports.Load(pin); ok {
		return t.(*http.Transport)
	}
	want, _ := hex.DecodeString(pin)
	t := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			mu.Lock()
			s := srv
			mu.Unlock()
			if s == nil {
				return nil, errors.New("Tailscale spento")
			}
			return s.Dial(ctx, network, addr)
		},
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // non ci si fida di un ente: si confronta l'impronta
			VerifyConnection: func(cs tls.ConnectionState) error {
				if len(cs.PeerCertificates) == 0 {
					return errors.New("nessun certificato")
				}
				got := sha256.Sum256(cs.PeerCertificates[0].Raw)
				if !strings.EqualFold(hex.EncodeToString(got[:]), hex.EncodeToString(want)) {
					return errors.New("certificato diverso da quello pubblicato")
				}
				return nil
			},
		},
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	actual, _ := transports.LoadOrStore(pin, t)
	return actual.(*http.Transport)
}

type pinned struct{}

func (pinned) RoundTrip(r *http.Request) (*http.Response, error) {
	pin := r.Header.Get("X-Bp-Pin")
	r.Header.Del("X-Bp-Pin")
	return transportFor(pin).RoundTrip(r)
}

func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, Range, X-Share-Token")
	h.Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type")
}

func handler() http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			// pr.In.URL.Path gia' controllato in ServeHTTP: /<segreto>/<host:porta>/<impronta>/<resto>
			parts := strings.SplitN(strings.TrimPrefix(pr.In.URL.Path, "/"), "/", 4)
			pr.Out.URL = &url.URL{Scheme: "https", Host: parts[1], Path: "/" + parts[3], RawQuery: pr.In.URL.RawQuery}
			pr.Out.Host = parts[1]
			pr.Out.Header.Set("X-Bp-Pin", parts[2])
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Referer")
			if pr.Out.Header.Get("X-Share-Token") == "" {
				if t, ok := tokens.Load(parts[1]); ok {
					pr.Out.Header.Set("X-Share-Token", t.(string))
				}
			}
		},
		Transport:     pinned{},
		FlushInterval: -1, // i video escono man mano che arrivano
		ModifyResponse: func(r *http.Response) error {
			r.Header.Del("Access-Control-Allow-Origin")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			cors(w)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			msg := strings.ReplaceAll(err.Error(), `"`, `'`)
			fmt.Fprintf(w, `{"detail":"Non raggiungibile: %s","offline":true}`, msg)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 4)
		mu.Lock()
		sec := secret
		mu.Unlock()
		if len(parts) < 4 || parts[0] != sec || !hostRe.MatchString(parts[1]) || !pinRe.MatchString(parts[2]) ||
			!strings.HasPrefix(parts[3], "api/share/") {
			http.Error(w, "non trovato", http.StatusNotFound)
			return
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}
