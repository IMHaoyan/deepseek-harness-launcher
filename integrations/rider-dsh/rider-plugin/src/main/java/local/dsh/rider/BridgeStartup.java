package local.dsh.rider;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import org.jetbrains.annotations.NotNull;

public final class BridgeStartup implements StartupActivity.DumbAware {
    @Override public void runActivity(@NotNull Project project) { BridgeService.install(project); }
}
