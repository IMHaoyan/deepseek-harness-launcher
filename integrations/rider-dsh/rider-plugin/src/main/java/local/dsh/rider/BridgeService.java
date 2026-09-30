package local.dsh.rider;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.event.SelectionListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerEvent;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.Key;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Owns one project's read-only editor observation; transport is separate from the IDE UI thread. */
public final class BridgeService implements Disposable {
    private static final Key<BridgeService> KEY = Key.create("dsh-rider-bridge-service");
    private static volatile BridgeService lastActive;
    private final Project project;
    private final ScheduledExecutorService jobs = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "dsh-rider-bridge"); t.setDaemon(true); return t;
    });
    // Cleartext h2c upgrade requests are dropped by the DSH web host (it has no 'upgrade'
    // listener), so speak HTTP/1.1 explicitly instead of Java's HTTP/2 default.
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(1)).build();
    private ScheduledFuture<?> pending;
    private volatile boolean disposed;

    private BridgeService(Project project) {
        this.project = project;
        project.getMessageBus().connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER,
            new FileEditorManagerListener() {
                @Override public void selectionChanged(@NotNull FileEditorManagerEvent event) { scheduleCurrent(); }
            });
        EditorFactory.getInstance().getEventMulticaster().addSelectionListener(new SelectionListener() {
            @Override public void selectionChanged(@NotNull com.intellij.openapi.editor.event.SelectionEvent event) {
                if (event.getEditor().getProject() == project &&
                    FileEditorManager.getInstance(project).getSelectedTextEditor() == event.getEditor()) scheduleCurrent();
            }
        }, this);
        jobs.scheduleAtFixedRate(() -> ApplicationManager.getApplication().invokeLater(() -> {
            if (!disposed && lastActive == this) publishCurrent();
        }), 5, 10, TimeUnit.SECONDS);
        scheduleCurrent();
    }

    public static synchronized BridgeService install(Project project) {
        BridgeService existing = project.getUserData(KEY);
        if (existing != null) return existing;
        BridgeService service = new BridgeService(project);
        project.putUserData(KEY, service);
        Disposer.register(project, service);
        return service;
    }

    private void scheduleCurrent() {
        if (disposed) return;
        lastActive = this;
        if (pending != null) pending.cancel(false);
        pending = jobs.schedule(() -> ApplicationManager.getApplication().invokeLater(this::publishCurrent), 160, TimeUnit.MILLISECONDS);
    }
    private void publishCurrent() {
        if (disposed || project.isDisposed() || lastActive != this) return;
        Editor editor = FileEditorManager.getInstance(project).getSelectedTextEditor();
        JsonObject packet = snapshot(editor, "state");
        if (packet == null && project.getBasePath() != null) {
            packet = new JsonObject();
            packet.addProperty("kind", "clear");
            packet.addProperty("projectRoot", project.getBasePath());
        }
        if (packet != null) {
            JsonObject update = packet;
            jobs.execute(() -> postQuiet(update));
        }
    }
    /** Called on the IDE action thread. Never truncates an explicit selection silently. */
    public String sendSelected(Editor editor) {
        JsonObject packet = snapshot(editor, "send");
        if (packet == null) return "文件不在本工程范围内，或选区超过 32 KiB；未发送。";
        lastActive = this;
        jobs.execute(() -> {
            try {
                JsonObject answer = post(packet);
                if (!answer.has("queued") || !answer.get("queued").getAsBoolean()) throw new IllegalStateException("DSH 未接收该草稿");
                notifyUser("已送达 DSH 桥接队列；等待匹配工作目录的聊天输入框接收。", NotificationType.INFORMATION);
            } catch (Exception ex) { notifyUser("发送失败：" + ex.getMessage(), NotificationType.WARNING); }
        });
        return null;
    }
    private void notifyUser(String text, NotificationType type) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!project.isDisposed()) NotificationGroupManager.getInstance().getNotificationGroup("DshRiderBridge")
                .createNotification(text, type).notify(project);
        });
    }
    private JsonObject snapshot(Editor editor, String kind) {
        if (editor == null || project.getBasePath() == null) return null;
        Document doc = editor.getDocument();
        VirtualFile file = FileDocumentManager.getInstance().getFile(doc);
        if (file == null) return null;
        // Anchor: the project base path, or the narrowest shared ancestor when the file lives in a
        // sibling source tree of the same checkout. Null means refuse — never guess a broader root.
        Path anchor = BridgeRoots.anchor(project.getBasePath(), file.getPath());
        if (anchor == null) return null;
        String selection = editor.getSelectionModel().getSelectedText();
        if (selection == null) selection = "";
        if (selection.length() > 32768) return null;
        int start = editor.getSelectionModel().hasSelection() ? editor.getSelectionModel().getSelectionStart() : editor.getCaretModel().getOffset();
        int end = editor.getSelectionModel().hasSelection() ? editor.getSelectionModel().getSelectionEnd() : start;
        int startLine = doc.getLineNumber(Math.min(start, doc.getTextLength())) + 1;
        int endLine = doc.getLineNumber(Math.max(start, end - 1)) + 1;
        if (endLine - startLine > 10000) return null;
        JsonObject packet = new JsonObject();
        packet.addProperty("kind", kind); packet.addProperty("projectRoot", anchor.toString());
        packet.addProperty("file", file.getPath()); packet.addProperty("lineStart", startLine);
        packet.addProperty("lineEnd", endLine); packet.addProperty("selection", selection);
        return packet;
    }
    private void postQuiet(JsonObject packet) { try { post(packet); } catch (Exception ignored) { /* no DSH: normal */ } }
    private JsonObject post(JsonObject packet) throws Exception {
        Descriptor d = singleInstance();
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + d.port + "/rider-dsh/push"))
            .header("authorization", "Bearer " + d.token).header("content-type", "application/json")
            .timeout(Duration.ofSeconds(2)).POST(HttpRequest.BodyPublishers.ofString(packet.toString())).build();
        HttpResponse<String> response = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 202) throw new IllegalStateException("DSH 拒绝接收 (HTTP " + response.statusCode() + ")");
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }
    private Descriptor singleInstance() throws Exception {
        String configuredHome = System.getenv("DSH_HOME");
        Path dir = Path.of(configuredHome != null && !configuredHome.isBlank() ? configuredHome : Path.of(System.getProperty("user.home"), ".dsh").toString(), "rider-bridge");
        if (!Files.isDirectory(dir)) throw new IllegalStateException("DSH Rider 插件未运行");
        List<Descriptor> live = new ArrayList<>();
        try (var files = Files.list(dir)) {
            for (Path file : files.filter(f -> f.getFileName().toString().endsWith(".json")).limit(32).toList()) {
                try {
                    JsonObject item = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
                    int port = item.get("port").getAsInt();
                    String token = item.get("token").getAsString(), instance = item.get("instance").getAsString();
                    if (item.get("protocol").getAsInt() != 1 || port < 1 || port > 65535 || !token.matches("[0-9a-f]{64}")) continue;
                    Descriptor d = new Descriptor(port, token, instance);
                    HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rider-dsh/health"))
                        .header("authorization", "Bearer " + token).timeout(Duration.ofMillis(900)).GET().build();
                    HttpResponse<String> reply = http.send(req, HttpResponse.BodyHandlers.ofString());
                    if (reply.statusCode() == 200 && instance.equals(JsonParser.parseString(reply.body()).getAsJsonObject().get("instance").getAsString())) live.add(d);
                } catch (Exception ignored) { /* stale or invalid descriptor is never trusted */ }
            }
        }
        if (live.isEmpty()) throw new IllegalStateException("没有运行中的 DSH Rider 桥接实例");
        if (live.size() != 1) throw new IllegalStateException("检测到多个 DSH 实例；为避免误发，请只保留一个");
        return live.get(0);
    }
    private record Descriptor(int port, String token, String instance) {}
    @Override public void dispose() {
        disposed = true;
        if (lastActive == this) lastActive = null;
        jobs.shutdownNow();
        project.putUserData(KEY, null);
    }
}




