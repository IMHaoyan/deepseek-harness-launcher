package local.dsh.rider;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

public final class SendToDshAction extends AnAction implements DumbAware {
    @Override public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getProject() != null &&
            event.getData(CommonDataKeys.EDITOR) != null && event.getData(CommonDataKeys.VIRTUAL_FILE) != null);
    }
    @Override public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getProject();
        if (project == null || event.getData(CommonDataKeys.EDITOR) == null) return;
        BridgeService service = BridgeService.install(project);
        String error = service.sendSelected(event.getData(CommonDataKeys.EDITOR));
        if (error != null) NotificationGroupManager.getInstance().getNotificationGroup("DshRiderBridge")
            .createNotification(error, NotificationType.WARNING).notify(project);
    }
}
