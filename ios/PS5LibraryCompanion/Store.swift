import Foundation
import Security
import SwiftUI

enum StoreError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}
enum Credentials {
    static func query(_ id: String) -> [String: Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"PS5Library",kSecAttrAccount as String:id] }
    static func read(_ id: String) -> String? { var q=query(id);q[kSecReturnData as String]=true;var value:CFTypeRef?;guard SecItemCopyMatching(q as CFDictionary,&value)==errSecSuccess,let data=value as? Data else{return nil};return String(data:data,encoding:.utf8) }
    static func save(_ token: String, id: String) throws { SecItemDelete(query(id) as CFDictionary);var q=query(id);q[kSecValueData as String]=Data(token.utf8);q[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;guard SecItemAdd(q as CFDictionary,nil)==errSecSuccess else{throw StoreError.message("Could not save your sign-in securely.")} }
    static func remove(_ id: String) { SecItemDelete(query(id) as CFDictionary) }
}
actor API {
    let base: URL; let token: String; let session: URLSession
    init(server: URL, token: String = "") throws {
        guard server.scheme=="https",server.host != nil,server.user==nil,server.password==nil,server.query==nil,server.fragment==nil,server.path.isEmpty||server.path=="/" else{throw StoreError.message("Enter your server's HTTPS address, for example https://library.example.net.")}
        base=server;self.token=token
        let config=URLSessionConfiguration.ephemeral;config.httpShouldSetCookies=false;config.timeoutIntervalForRequest=20
        config.urlCache=URLCache(memoryCapacity:32*1024*1024,diskCapacity:128*1024*1024,diskPath:"PS5Library-"+server.host!)
        session=URLSession(configuration:config)
    }
    func url(_ path: String) throws -> URL {
        guard path.hasPrefix("/api/v1/"),!path.contains(".."),let url=URL(string:path,relativeTo:base)?.absoluteURL,url.host==base.host,url.port==base.port,url.scheme==base.scheme else{throw StoreError.message("Invalid server resource.")};return url
    }
    func makeRequest(_ path: String) throws -> URLRequest { var request=URLRequest(url:try url(path));request.setValue("Bearer "+token,forHTTPHeaderField:"Authorization");return request }
    func request<T:Decodable>(_ path: String, method: String = "GET", json: [String:String] = [:]) async throws -> T {
        var request=try makeRequest("/api/v1"+path);request.httpMethod=method
        if method != "GET" { request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=try JSONEncoder().encode(json) }
        let (data,response)=try await session.data(for:request)
        guard let response=response as? HTTPURLResponse,(200..<300).contains(response.statusCode) else { let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any];throw StoreError.message(readable(value?["error"] as? String ?? "Server request failed")) }
        guard data.count<=12*1024*1024 else{throw StoreError.message("Server response is too large.")}
        return try JSONDecoder().decode(T.self,from:data)
    }
    func artwork(_ path:String) async throws -> Data { let(data,response)=try await session.data(for:makeRequest(path));guard (response as? HTTPURLResponse)?.statusCode==200,data.count<=12*1024*1024 else{throw StoreError.message("Artwork unavailable")};return data }
    func events(after:Int64) throws -> URLSessionWebSocketTask { var request=try makeRequest("/api/v1/events/live?after=\(after)");var url=URLComponents(url:request.url!,resolvingAgainstBaseURL:false)!;url.scheme="wss";request.url=url.url;let socket=session.webSocketTask(with:request);socket.resume();return socket }
}
@MainActor final class Store: ObservableObject {
    @Published var accounts:[Account]=[];@Published var account:Account?;@Published var data=Snapshot(games:[],consoles:[],jobs:[],featured:nil,library:[],consoleId:"")
    @Published var error:String?;@Published var offline=false;@Published var loading=false
    var api:API?;private var poll:Task<Void,Never>?;private var live:Task<Void,Never>?;private var socket:URLSessionWebSocketTask?;private var refreshing=false
    init(){if let saved=UserDefaults.standard.data(forKey:"accounts"){accounts=(try? JSONDecoder().decode([Account].self,from:saved)) ?? []};if let id=UserDefaults.standard.string(forKey:"activeAccount"),let selected=accounts.first(where:{$0.id==id}){activate(selected)}}
    func cache(_ id:String) throws -> URL { let folder=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true).appendingPathComponent("PS5Library",isDirectory:true);try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true);return folder.appendingPathComponent(id+".json") }
    func activate(_ selected:Account){poll?.cancel();live?.cancel();socket?.cancel(with:.goingAway,reason:nil);account=selected;api=nil;refreshing=false;data=Snapshot(games:[],consoles:[],jobs:[],featured:nil,library:[],consoleId:"");offline=true
        if let file=try? cache(selected.id),let saved=try? Data(contentsOf:file),let value=try? JSONDecoder().decode(Snapshot.self,from:saved){data=value}
        guard let token=Credentials.read(selected.id) else{error="Sign in to this account again.";account=nil;return}
        do{api=try API(server:selected.server,token:token)}catch{self.error=error.localizedDescription;return}
        UserDefaults.standard.set(selected.id,forKey:"activeAccount");poll=Task{while !Task.isCancelled{await refresh();try? await Task.sleep(nanoseconds:10_000_000_000)}}
        live=Task{var cursor:Int64=0;while !Task.isCancelled{do{guard let api=self.api else{return};let connection=try await api.events(after:cursor);socket=connection
            while !Task.isCancelled{let message=try await connection.receive();let bytes:Data;switch message{case .data(let value):bytes=value;case .string(let value):bytes=Data(value.utf8);@unknown default:continue};if let events=try? JSONDecoder().decode(Events.self,from:bytes){cursor=events.events.last?.id ?? cursor};await refresh()}
        }catch{if Task.isCancelled{return};try? await Task.sleep(nanoseconds:5_000_000_000)}}}
    }
    func refresh() async { guard !refreshing,let api=api,let selected=account else{return};refreshing=true;loading=data.games.isEmpty;defer{if account?.id==selected.id{refreshing=false;loading=false}}
        do{async let games:[Game]=api.request("/catalog");async let consoles:[Console]=api.request("/consoles");async let jobs:[Job]=api.request("/jobs");async let featured:Featured=api.request("/featured")
            let fetched=try await(games,consoles,jobs,featured);let id=data.consoleId.isEmpty ? (fetched.1.first(where:{$0.isDefault})?.id ?? fetched.1.first?.id ?? "") : data.consoleId
            let library:[LibraryEntry]=id.isEmpty ? [] : try await api.request("/consoles/\(id)/library")
            guard account?.id==selected.id,!Task.isCancelled else{return};data=Snapshot(games:fetched.0,consoles:fetched.1,jobs:fetched.2,featured:fetched.3,library:library,consoleId:id);offline=false
            if let file=try? cache(selected.id),let encoded=try? JSONEncoder().encode(data){try? encoded.write(to:file,options:[.atomic,.completeFileProtection])}
        }catch{if account?.id==selected.id,!Task.isCancelled{offline=true;self.error=error.localizedDescription}}
    }
    func login(server:String,username:String,password:String,invite:String,register:Bool) async throws { guard let url=URL(string:server) else{throw StoreError.message("Invalid server address")};let client=try API(server:url);var body=["username":username,"password":password];if register{body["inviteToken"]=invite};let result:Login=try await client.request(register ? "/auth/register":"/auth/login",method:"POST",json:body)
        let id=accounts.first(where:{$0.server==url&&$0.username==username})?.id ?? UUID().uuidString;let profile=Account(id:id,server:url,username:result.user.username,role:result.user.role);try Credentials.save(result.token,id:id);accounts.removeAll(where:{$0.id==id});accounts.append(profile);UserDefaults.standard.set(try JSONEncoder().encode(accounts),forKey:"accounts");activate(profile)
    }
    func perform(_ action: @escaping (API) async throws -> Void) { guard let api=api else{return};let owner=account?.id;Task{do{try await action(api);if account?.id==owner{await refresh()}}catch{if account?.id==owner{self.error=error.localizedDescription}}} }
    func ready(_ game:Game)->Bool { game.releases.contains{release in data.library.contains{$0.releaseId==release.id&&$0.state=="READY_ON_PS5"}} }
    func signOut(){let old=api,profile=account;poll?.cancel();live?.cancel();socket?.cancel(with:.goingAway,reason:nil);api=nil;account=nil;data=Snapshot(games:[],consoles:[],jobs:[],featured:nil,library:[],consoleId:"");if let profile=profile{Credentials.remove(profile.id);accounts.removeAll{$0.id==profile.id};if let file=try? cache(profile.id){try? FileManager.default.removeItem(at:file)}};UserDefaults.standard.set(try? JSONEncoder().encode(accounts),forKey:"accounts");Task{let _:Acknowledgement?=try? await old?.request("/auth/logout",method:"POST")} }
}
