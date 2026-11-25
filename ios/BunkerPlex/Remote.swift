import Bpnet
import CommonCrypto
import Foundation
import UIKit

/// L'app senza il server di casa: entra con l'account nel servizio account
/// (Cloudflare), da li' sa chi sono gli amici e i tuoi PC, e li raggiunge con il
/// Tailscale dentro l'app. Come Remote.kt dell'app Android.
enum Remote {
    static let defaultCloud = "https://bunkerplex-account.bunkerplex.workers.dev"
    private static let prefs = UserDefaults.standard

    struct CloudError: Error {
        let status: Int
        let message: String
        var data: String = ""
    }

    static var cloud: String {
        if let c = prefs.string(forKey: "cloud"), c.hasPrefix("https://") { return c }
        return defaultCloud
    }

    static func setCloud(_ url: String?) {
        guard var u = url, u.hasPrefix("https://") else { return }
        while u.hasSuffix("/") { u.removeLast() }
        prefs.set(u, forKey: "cloud")
    }

    static var token: String { prefs.string(forKey: "cloud_token") ?? "" }
    static var account: String { token.isEmpty ? "" : (prefs.string(forKey: "cloud_user") ?? "") }

    /// "iPhone" o "iPad": il nome con cui il dispositivo compare nell'account.
    static var deviceLabel: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }

    /// La password non lascia mai il telefono: al servizio va un'impronta lenta da
    /// calcolare (PBKDF2-SHA256, 200.000 giri, sale "bunkerplex:" + nome), come sul PC.
    static func verifier(_ username: String, _ password: String) -> String {
        let salt = Array(("bunkerplex:" + username.trimmingCharacters(in: .whitespaces).lowercased()).utf8)
        let pass = Array(password.utf8)
        var key = [UInt8](repeating: 0, count: 32)
        _ = pass.withUnsafeBufferPointer { p in
            p.baseAddress!.withMemoryRebound(to: Int8.self, capacity: pass.count) { pp in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pp, pass.count, salt, salt.count,
                                     CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 200_000, &key, key.count)
            }
        }
        return key.map { String(format: "%02x", $0) }.joined()
    }

    /// Una chiamata al servizio account: la risposta JSON (testo), o CloudError.
    static func call(_ method: String, _ path: String, _ body: String?) throws -> String {
        guard let url = URL(string: cloud + path) else { throw CloudError(status: 0, message: "Indirizzo non valido") }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("BunkerPlex", forHTTPHeaderField: "User-Agent")
        if !token.isEmpty { req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let b = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = b.data(using: .utf8)
        }
        guard let (code, data) = Net.send(req) else {
            throw CloudError(status: 0, message: "Non riesco a contattare il servizio account: controlla la connessione")
        }
        let text = String(data: data, encoding: .utf8) ?? ""
        if code >= 400 {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let detail = obj?["detail"] as? String ?? ""
            if code == 401 && path != "/login" { logout() }
            throw CloudError(status: code, message: detail.isEmpty ? "Servizio account: errore \(code)" : detail, data: text)
        }
        return text
    }

    static func json(_ obj: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return "{}" }
        return String(data: d, encoding: .utf8) ?? "{}"
    }

    static func parse(_ text: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
    }

    private static func keep(_ res: [String: Any], fallback: String) {
        guard let t = res["token"] as? String, !t.isEmpty else { return }
        prefs.set(t, forKey: "cloud_token")
        let user = (res["user"] as? [String: Any])?["username"] as? String
        prefs.set(user ?? fallback, forKey: "cloud_user")
    }

    static func login(_ username: String, _ password: String) throws -> String {
        let name = username.trimmingCharacters(in: .whitespaces)
        prefs.removeObject(forKey: "cloud_token")
        let text = try call("POST", "/login", json(["username": name, "verifier": verifier(name, password),
                                                    "device": deviceLabel]))
        keep(parse(text), fallback: name)
        return text
    }

    /// «Entra con Google»: un indirizzo da aprire in Safari, poi si chiede l'esito.
    static func googleStart() throws -> String {
        prefs.removeObject(forKey: "cloud_token")
        return try call("POST", "/google/start", json(["device": deviceLabel, "kind": "phone"]))
    }

    static func googlePoll(_ poll: String) throws -> String {
        let text = try call("POST", "/google/poll", json(["poll": poll]))
        keep(parse(text), fallback: "")
        return text
    }

    static func logout() {
        prefs.removeObject(forKey: "cloud_token")
        stopNet()
    }

    // ---- Tailscale dentro l'app

    /// Il nome di questo dispositivo nella rete: sempre lo stesso per questa app
    /// installata (cosi' rientrando non conta come un dispositivo in piu').
    private static var host: String {
        var id = prefs.string(forKey: "net_id") ?? ""
        if id.range(of: "^[0-9a-f]{6}$", options: .regularExpression) == nil {
            id = String((0..<6).map { _ in "0123456789abcdef".randomElement()! })
            prefs.set(id, forKey: "net_id")
        }
        return "bunkerplex-app-\(deviceLabel.lowercased())-\(id)"
    }

    private static let netLock = NSLock()

    /// Entra nella rete di BunkerPlex (se non c'e' gia'): la base del proxy locale.
    /// Lento: fuori dal thread principale.
    static func startNet(replace: String) throws -> String {
        netLock.lock(); defer { netLock.unlock() }
        let base = BpnetBase()
        if !base.isEmpty { return base }
        var body: [String: Any] = ["ephemeral": true, "kind": "app", "host": host, "label": deviceLabel]
        if !replace.isEmpty { body["replace"] = replace }
        let text: String
        do {
            text = try call("POST", "/tailscale/key", json(body))
        } catch let e as CloudError {
            if e.status == 409 { throw e }
            throw CloudError(status: e.status, message: e.status == 404 ? "Il servizio account non ha Tailscale configurato" : e.message)
        }
        guard let key = parse(text)["key"] as? String, !key.isEmpty else {
            throw CloudError(status: 0, message: "Il servizio account non ha dato la chiave")
        }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("tailscale", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let err = BpnetStart(dir.path, key, host)
        if !err.isEmpty { throw CloudError(status: 0, message: err) }
        return BpnetBase()
    }

    static func stopNet() { BpnetStop() }

    static func setToken(_ hostport: String, _ token: String) { BpnetSetToken(hostport, token) }
}
