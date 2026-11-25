import UIKit
import WebKit

/// Mostra l'interfaccia di BunkerPlex servita dal PC di casa (la stessa del
/// browser: i video arrivano in HLS e li riproduce iOS). Al primo avvio cerca da
/// solo il server sulla rete di casa; fuori casa apre remote.html (amici e tuoi
/// PC con Tailscale). setup.html e remote.html sono quelle dell'app Android:
/// parlano con l'app attraverso un ponte BunkerPlexTV, qui ricreato in JavaScript
/// sopra i messaggi di WebKit (le risposte lente tornano in remoteDone).
final class MainController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {

    private var web: WKWebView!
    private let prefs = UserDefaults.standard
    private var onSetup = false
    private var lastOpen = Date.distantPast
    private var active: String?

    private var server: String? {
        get { prefs.string(forKey: "server") }
        set { prefs.set(newValue, forKey: "server") }
    }

    /// Gli altri indirizzi dello stesso PC (es. Tailscale), li dice il server.
    private var others: [String] {
        get { (prefs.string(forKey: "server_others") ?? "").split(separator: " ").map(String.init) }
        set {
            var seen = Set<String>()
            prefs.set(newValue.filter { seen.insert($0).inserted }.joined(separator: " "), forKey: "server_others")
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.background

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsPictureInPictureMediaPlayback = true
        cfg.allowsAirPlayForMediaPlayback = true
        cfg.websiteDataStore = .default()
        cfg.applicationNameForUserAgent = "BunkerPlexiOS Version/17.0 Mobile/15E148 Safari/604.1"
        cfg.userContentController.add(WeakHandler(self), name: "bpios")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = Theme.background
        web.scrollView.backgroundColor = Theme.background
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        NotificationCenter.default.addObserver(self, selector: #selector(foreground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
        if server == nil { showSetup("") } else { openServer() }
    }

    /// Tornando nell'app dopo tanto (es. si e' usciti di casa) si ricontrolla la strada.
    @objc private func foreground() {
        if !onSetup, Date().timeIntervalSince(lastOpen) > 600 { openServer() }
    }

    // ---- Server di casa

    /// Apre BunkerPlex dal primo indirizzo che risponde: prima quello di casa, poi
    /// gli altri del PC. Se nessuno risponde: amici e tuoi PC da fuori casa.
    private func openServer() {
        guard let home = server else { return showSetup("") }
        onSetup = false
        lastOpen = Date()
        let list = [home] + others.filter { $0 != home }
        DispatchQueue.global(qos: .userInitiated).async {
            var found: String?
            for url in list {
                guard let info = Net.info(url, timeout: url == home ? 3 : 6) else { continue }
                Remote.setCloud(info["cloud"] as? String)
                if let a = info["addresses"] as? [String] { self.others = a.map(Net.normalize) }
                found = url
                break
            }
            DispatchQueue.main.async {
                guard let url = found else { return self.showRemote("ask") }
                self.active = url
                self.onSetup = false
                self.load(URL(string: url + "/#/home"))
            }
        }
    }

    private func lost() {
        if Date().timeIntervalSince(lastOpen) > 15 { openServer() } else { showRemote("ask") }
    }

    private func load(_ url: URL?) {
        guard let url = url else { return }
        installShim()
        web.load(URLRequest(url: url))
    }

    private func showSetup(_ hash: String) { showPage("setup", hash) }

    private func showRemote(_ hash: String) { showPage("remote", hash) }

    private func showPage(_ name: String, _ hash: String) {
        guard let file = Bundle.main.url(forResource: name, withExtension: "html") else { return }
        onSetup = true
        installShim()
        let target = URL(string: file.absoluteString + (hash.isEmpty ? "" : "#" + hash)) ?? file
        web.loadFileURL(target, allowingReadAccessTo: file.deletingLastPathComponent())
    }

    // ---- Il ponte con le pagine

    /// Solo nelle pagine dell'app (file://) compare window.BunkerPlexTV: le pagine del
    /// server vedono solo window.webkit.messageHandlers.bpios (vedi IOS_APP in app.js).
    private func installShim() {
        let state = Remote.json(["account": Remote.account, "server": active ?? server ?? ""])
        let js = """
        (function () {
          if (location.protocol !== 'file:') return;
          var s = \(state);
          function post(fn, args) { window.webkit.messageHandlers.bpios.postMessage({ fn: fn, args: args }); }
          var o = {
            isTv: function () { return false; },
            remoteAccount: function () { return s.account || ''; },
            getServer: function () { return s.server || ''; }
          };
          ['remoteLogin', 'remoteGoogleStart', 'remoteGooglePoll', 'remoteCloud', 'remoteNet', 'remoteToken',
           'remotePlay', 'openUrl', 'retryHome', 'openSetup', 'openRemote', 'discover', 'saveServer',
           'remoteLogout', 'resetServer'].forEach(function (n) {
            o[n] = function () {
              if (n === 'remoteLogout') s.account = '';
              post(n, Array.prototype.slice.call(arguments));
            };
          });
          window.__bpState = s;
          window.BunkerPlexTV = o;
        })();
        """
        let ucc = web.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func js(_ code: String) {
        DispatchQueue.main.async { self.web.evaluateJavaScript(code, completionHandler: nil) }
    }

    private func quote(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let a = String(data: d, encoding: .utf8) ?? "[\"\"]"
        return String(a.dropFirst().dropLast())
    }

    private func done(_ cb: Int, _ ok: Bool, _ text: String) {
        js("window.remoteDone&&remoteDone(\(cb),\(ok),\(quote(text)))")
    }

    private func setAccount() {
        js("window.__bpState&&(__bpState.account=\(quote(Remote.account)))")
    }

    private func errorJSON(_ e: Error) -> String {
        if let c = e as? Remote.CloudError {
            return Remote.json(["status": c.status, "detail": c.message])
        }
        return Remote.json(["detail": e.localizedDescription])
    }

    /// Lavoro lento fuori dal thread principale.
    private func bg(_ work: @escaping () -> Void) { DispatchQueue.global(qos: .userInitiated).async(execute: work) }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let fn = body["fn"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        func str(_ i: Int) -> String { i < args.count ? (args[i] as? String ?? "\(args[i])") : "" }
        func num(_ i: Int) -> Int { i < args.count ? ((args[i] as? NSNumber)?.intValue ?? 0) : 0 }
        let fromApp = message.frameInfo.request.url?.isFileURL ?? false

        switch fn {
        // Dalle pagine del server: solo queste due
        case "resetServer":
            showSetup("")
        case "openRemote":
            showRemote("friends")
        default:
            guard fromApp else { return }
            handleApp(fn, str, num)
        }
    }

    private func handleApp(_ fn: String, _ str: (Int) -> String, _ num: (Int) -> Int) {
        switch fn {
        case "discover":
            bg {
                if let url = Net.discover() {
                    DispatchQueue.main.async {
                        self.server = url
                        self.others = []
                        self.js("setupFound(\(self.quote(url)))")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { if self.onSetup { self.openServer() } }
                    }
                } else {
                    self.js("setupNotFound()")
                }
            }
        case "saveServer":
            let url = Net.normalize(str(0))
            bg {
                if Net.info(url, timeout: 4) != nil {
                    DispatchQueue.main.async {
                        self.server = url
                        self.others = []
                        self.openServer()
                    }
                } else {
                    self.js("setupError(\(self.quote(url)))")
                }
            }
        case "retryHome":
            if server == nil { showSetup("") } else { openServer() }
        case "openSetup":
            showSetup("manual")
        case "remoteLogin":
            let (u, p, cb) = (str(0), str(1), num(2))
            bg {
                do {
                    let t = try Remote.login(u, p)
                    self.setAccount()
                    self.done(cb, true, t)
                } catch {
                    self.done(cb, false, (error as? Remote.CloudError)?.message ?? "Accesso non riuscito")
                }
            }
        case "remoteLogout":
            Remote.logout()
        case "remoteGoogleStart":
            let cb = num(0)
            bg {
                do { self.done(cb, true, try Remote.googleStart()) } catch {
                    self.done(cb, false, (error as? Remote.CloudError)?.message ?? "Servizio account non raggiungibile")
                }
            }
        case "remoteGooglePoll":
            let (poll, cb) = (str(0), num(1))
            bg {
                do {
                    let t = try Remote.googlePoll(poll)
                    self.setAccount()
                    self.done(cb, true, t)
                } catch { self.done(cb, false, self.errorJSON(error)) }
            }
        case "openUrl":
            let u = str(0)
            if u.hasPrefix("https://"), let url = URL(string: u) { UIApplication.shared.open(url) }
        case "remoteCloud":
            let (m, path, b, cb) = (str(0), str(1), str(2), num(3))
            bg {
                do { self.done(cb, true, try Remote.call(m, path, b.isEmpty ? nil : b)) } catch {
                    self.done(cb, false, self.errorJSON(error))
                }
            }
        case "remoteNet":
            let (replace, cb) = (str(0), num(1))
            bg {
                do { self.done(cb, true, try Remote.startNet(replace: replace)) } catch let e as Remote.CloudError where e.status == 409 {
                    // Al limite dei dispositivi: la pagina chiede quale togliere
                    let lim = Remote.parse(e.data)
                    self.done(cb, false, Remote.json(["limit": lim, "detail": e.message]))
                } catch {
                    self.done(cb, false, Remote.json(["detail": (error as? Remote.CloudError)?.message ?? "Tailscale non parte"]))
                }
            }
        case "remoteToken":
            Remote.setToken(str(0), str(1))
        case "remotePlay":
            Player.play(from: self, base: str(0), json: str(1))
        default:
            break
        }
    }

    // ---- Navigazione

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if !onSetup { lost() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if !onSetup { lost() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        // Indirizzi fuori da BunkerPlex (es. Google, GitHub): in Safari
        let home = URL(string: active ?? server ?? "")?.host
        let outside = (url.scheme == "https" || url.scheme == "http") && url.host != home &&
            action.navigationType == .linkActivated && action.targetFrame?.isMainFrame != false
        if outside || url.scheme == "mailto" || url.scheme == "tel" {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    /// target=_blank e window.open: in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == URL(string: active ?? server ?? "")?.host { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // Finestre di conferma della pagina (confirm/alert): con quelle di iOS
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Annulla", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Annulla", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }
}

/// WKUserContentController tiene forte il suo gestore: questo evita il giro chiuso.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
