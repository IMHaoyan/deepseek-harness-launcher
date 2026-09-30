package local.dsh.rider;

import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Decides which anchor root may carry one editor file to the DSH bridge.
 *
 * The project base path is always accepted. A file outside it is accepted only when it shares
 * a drive and a common ancestor with the base path that is still narrow enough to mean "the
 * same checkout": the ancestor must not be a filesystem or UNC root, and must not be the user
 * profile, the Windows directory, an install directory, or a temp directory. Everything else is
 * refused — the bridge never guesses a broader root than the one it can justify.
 */
final class BridgeRoots {
    private BridgeRoots() {}

    /**
     * Resolve the anchor root for one editor file.
     * @param basePath the IDE project base path, or null.
     * @param filePath absolute path of the file the editor has open.
     * @return the project base path, a shared narrow ancestor, or null when the file must be refused.
     */
    static Path anchor(String basePath, String filePath) {
        if (basePath == null || filePath == null) return null;
        Path base = Path.of(basePath).normalize().toAbsolutePath();
        Path file;
        try {
            file = Path.of(filePath).normalize().toAbsolutePath();
        } catch (RuntimeException invalid) {
            return null;
        }
        if (file.startsWith(base)) return base;
        Path root = base.getRoot();
        if (root == null || !root.toString().equalsIgnoreCase(String.valueOf(file.getRoot()))) return null;
        Path common = root;
        int limit = Math.min(base.getNameCount(), file.getNameCount());
        for (int index = 0; index < limit; index++) {
            String left = base.getName(index).toString(), right = file.getName(index).toString();
            if (!left.equalsIgnoreCase(right)) break;
            common = common.resolve(left);
        }
        if (common.getNameCount() == 0) return null;
        return broad(common) ? null : common;
    }

    /** Whether one ancestor is too broad to stand for a single checkout. */
    private static boolean broad(Path ancestor) {
        return broadRoots().contains(ancestor.toString().toLowerCase(Locale.ROOT));
    }

    /** Roots that never anchor a file: environment-derived, so no drive or layout is hardcoded. */
    private static Set<String> broadRoots() {
        Set<String> roots = new LinkedHashSet<>();
        for (String name : new String[] { "USERPROFILE", "SystemRoot", "windir", "ProgramFiles",
                "ProgramFiles(x86)", "ProgramData", "TEMP", "TMP", "LOCALAPPDATA" }) {
            add(roots, System.getenv(name));
        }
        String home = System.getProperty("user.home");
        add(roots, home);
        add(roots, parentOf(home));
        return roots;
    }

    private static void add(Set<String> roots, String value) {
        if (value == null || value.isBlank()) return;
        try {
            roots.add(Path.of(value).normalize().toAbsolutePath().toString().toLowerCase(Locale.ROOT));
        } catch (RuntimeException ignored) {
            // An unusable environment entry is not a rule.
        }
    }

    private static String parentOf(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            Path parent = Path.of(value).normalize().toAbsolutePath().getParent();
            return parent == null ? null : parent.toString();
        } catch (RuntimeException ignored) {
            return null;
        }
    }
}
