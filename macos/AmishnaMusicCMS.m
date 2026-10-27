#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <fcntl.h>

@interface AmishnaCMSAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSTask *serverTask;
@property(nonatomic, strong) NSFileHandle *logHandle;
@property(nonatomic, strong) NSMutableSet<NSString *> *reservedDownloadPaths;
@property(nonatomic, strong) NSMapTable<WKDownload *, NSURL *> *downloadDestinations;
@property(nonatomic, strong) NSURL *projectURL;
@property(nonatomic, strong) NSURL *databaseURL;
@property(nonatomic, strong) NSURL *backupDirectoryURL;
@property(nonatomic) BOOL ownsServer;
@property(nonatomic) BOOL hasLoadedDashboard;
@property(nonatomic) BOOL isTerminating;
- (void)showDownloadError:(NSString *)message;
@end

@implementation AmishnaCMSAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self installApplicationMenu];
    self.reservedDownloadPaths = [NSMutableSet set];
    self.downloadDestinations = [NSMapTable strongToStrongObjectsMapTable];

    self.projectURL = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Project" isDirectory:YES];
    if (![self prepareUserDataDirectory]) return;
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;

    NSRect frame = NSMakeRect(0, 0, 1280, 820);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"Amishna Music CMS";
    self.window.minSize = NSMakeSize(900, 620);
    [self.window setFrameAutosaveName:@"AmishnaMusicCMSMainWindow"];
    self.window.contentView = self.webView;
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    [self connectOrStartServer];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    self.isTerminating = YES;
    if (self.ownsServer && self.serverTask.isRunning) {
        [self.serverTask terminate];
    }
    [self.logHandle closeFile];
}

- (void)installApplicationMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:@"Undo"
                                               action:@selector(undo:)
                                        keyEquivalent:@"z"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:@"Redo"
                                               action:@selector(redo:)
                                        keyEquivalent:@"Z"]];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:@"Cut"
                                               action:@selector(cut:)
                                        keyEquivalent:@"x"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:@"Copy"
                                               action:@selector(copy:)
                                        keyEquivalent:@"c"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:@"Paste"
                                               action:@selector(paste:)
                                        keyEquivalent:@"v"]];
    [editMenu addItem:[[NSMenuItem alloc] initWithTitle:@"Select All"
                                               action:@selector(selectAll:)
                                        keyEquivalent:@"a"]];
    editMenuItem.submenu = editMenu;

    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    NSMenu *appMenu = [[NSMenu alloc] init];
    NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit Amishna Music CMS"
                                                      action:@selector(terminate:)
                                               keyEquivalent:@"q"];
    [appMenu addItem:quitItem];
    appMenuItem.submenu = appMenu;
    [mainMenu addItem:appMenuItem];
    [mainMenu addItem:editMenuItem];
    NSApp.mainMenu = mainMenu;
}

- (void)webView:(WKWebView *)webView
runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
initiatedByFrame:(WKFrameInfo *)frame
completionHandler:(void (^)(NSArray<NSURL *> * _Nullable URLs))completionHandler {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = parameters.allowsDirectories;
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    panel.canCreateDirectories = NO;

    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}

- (void)webView:(WKWebView *)webView
decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (@available(macOS 11.3, *)) {
        if (navigationAction.shouldPerformDownload) {
            decisionHandler(WKNavigationActionPolicyDownload);
            return;
        }
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView
navigationAction:(WKNavigationAction *)navigationAction
didBecomeDownload:(WKDownload *)download API_AVAILABLE(macos(11.3)) {
    download.delegate = self;
}

- (void)webView:(WKWebView *)webView
navigationResponse:(WKNavigationResponse *)navigationResponse
didBecomeDownload:(WKDownload *)download API_AVAILABLE(macos(11.3)) {
    download.delegate = self;
}

- (void)download:(WKDownload *)download
decideDestinationUsingResponse:(NSURLResponse *)response
suggestedFilename:(NSString *)suggestedFilename
completionHandler:(void (^)(NSURL * _Nullable destination))completionHandler API_AVAILABLE(macos(11.3)) {
    NSError *error = nil;
    NSURL *downloadsURL = [NSFileManager.defaultManager URLForDirectory:NSDownloadsDirectory
                                                               inDomain:NSUserDomainMask
                                                      appropriateForURL:nil
                                                                 create:YES
                                                                  error:&error];
    if (downloadsURL == nil) {
        [self showDownloadError:error.localizedDescription ?: @"Could not access your Downloads folder."];
        completionHandler(nil);
        return;
    }

    NSString *filename = suggestedFilename.lastPathComponent;
    if (filename.length == 0 || [filename isEqualToString:@"."] || [filename isEqualToString:@"/"]) {
        filename = @"Amishna Music CMS download";
    }
    NSString *extension = filename.pathExtension;
    NSString *base = extension.length > 0 ? [filename stringByDeletingPathExtension] : filename;
    NSFileManager *fileManager = NSFileManager.defaultManager;
    NSURL *destination = [downloadsURL URLByAppendingPathComponent:filename];
    NSUInteger suffix = 2;
    while ([fileManager fileExistsAtPath:destination.path] || [self.reservedDownloadPaths containsObject:destination.path]) {
        NSString *candidate = extension.length > 0
            ? [NSString stringWithFormat:@"%@ (%lu).%@", base, (unsigned long)suffix, extension]
            : [NSString stringWithFormat:@"%@ (%lu)", base, (unsigned long)suffix];
        destination = [downloadsURL URLByAppendingPathComponent:candidate];
        suffix++;
    }

    [self.reservedDownloadPaths addObject:destination.path];
    [self.downloadDestinations setObject:destination forKey:download];
    completionHandler(destination);
}

- (void)downloadDidFinish:(WKDownload *)download API_AVAILABLE(macos(11.3)) {
    NSURL *destination = [self.downloadDestinations objectForKey:download];
    if (destination) [self.reservedDownloadPaths removeObject:destination.path];
    [self.downloadDestinations removeObjectForKey:download];
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData API_AVAILABLE(macos(11.3)) {
    NSURL *destination = [self.downloadDestinations objectForKey:download];
    if (destination) [self.reservedDownloadPaths removeObject:destination.path];
    [self.downloadDestinations removeObjectForKey:download];
    [self showDownloadError:error.localizedDescription ?: @"The file could not be saved."];
}

- (NSURL *)healthURL {
    return [NSURL URLWithString:@"http://127.0.0.1:4000/api/health"];
}

- (NSURL *)dashboardURL {
    return [NSURL URLWithString:@"http://127.0.0.1:4175/"];
}

- (void)connectOrStartServer {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:self.healthURL];
    request.timeoutInterval = 1;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request
                                     completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.isTerminating) return;
            if (error == nil) [self loadDashboard];
            else [self startServer];
        });
    }] resume];
}

- (void)startServer {
    NSURL *nodeURL = [self.projectURL URLByAppendingPathComponent:
        @".local-runtime/node-v24.14.0-darwin-arm64/bin/node"];
    if (![NSFileManager.defaultManager isExecutableFileAtPath:nodeURL.path]) {
        [self showStartupError:@"The local Node.js runtime is missing. Keep the .local-runtime folder beside the app."];
        return;
    }

    NSTask *task = [[NSTask alloc] init];
    task.executableURL = nodeURL;
    task.arguments = @[@"scripts/dev.js"];
    task.currentDirectoryURL = self.projectURL;
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"SQLITE_PATH"] = self.databaseURL.path;
    environment[@"BACKUP_DIRECTORY"] = self.backupDirectoryURL.path;
    task.environment = environment;

    self.logHandle = [self createLogHandle];
    NSFileHandle *outputHandle = self.logHandle;
    if (outputHandle == nil) {
        int nullDescriptor = open("/dev/null", O_WRONLY);
        outputHandle = [[NSFileHandle alloc] initWithFileDescriptor:nullDescriptor closeOnDealloc:YES];
    }
    task.standardOutput = outputHandle;
    task.standardError = outputHandle;
    task.terminationHandler = ^(NSTask *terminatedTask) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!self.isTerminating && !self.hasLoadedDashboard && terminatedTask.terminationStatus != 0) {
                [self showStartupError:@"The CMS server stopped while starting. See ~/Library/Logs/Amishna Music CMS.log for details."];
            }
        });
    };

    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        [self showStartupError:[NSString stringWithFormat:@"The CMS could not start: %@", error.localizedDescription]];
        return;
    }
    self.serverTask = task;
    self.ownsServer = YES;
    [self waitForServerAttempt:0];
}

- (BOOL)prepareUserDataDirectory {
    NSError *error = nil;
    NSURL *supportURL = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory
                                                              inDomain:NSUserDomainMask
                                                     appropriateForURL:nil
                                                                create:YES
                                                                 error:&error];
    if (supportURL == nil) {
        [self showStartupError:[NSString stringWithFormat:@"Could not find the local app data folder: %@", error.localizedDescription]];
        return NO;
    }
    NSURL *dataDirectory = [supportURL URLByAppendingPathComponent:@"Amishna Music CMS" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:dataDirectory
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:&error]) {
        [self showStartupError:[NSString stringWithFormat:@"Could not create the local app data folder: %@", error.localizedDescription]];
        return NO;
    }
    self.databaseURL = [dataDirectory URLByAppendingPathComponent:@"amishna.sqlite"];
    self.backupDirectoryURL = [dataDirectory URLByAppendingPathComponent:@"Database" isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:self.backupDirectoryURL
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:&error]) {
        [self showStartupError:[NSString stringWithFormat:@"Could not create the local database backup folder: %@", error.localizedDescription]];
        return NO;
    }
    return YES;
}

- (void)waitForServerAttempt:(NSUInteger)attempt {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:self.healthURL];
    request.timeoutInterval = 1;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request
                                     completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.isTerminating || self.hasLoadedDashboard) return;
            if (error == nil) {
                [self loadDashboard];
            } else if (attempt < 60) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC / 2)),
                               dispatch_get_main_queue(), ^{
                    [self waitForServerAttempt:attempt + 1];
                });
            } else {
                [self showStartupError:@"The CMS is taking too long to start. See ~/Library/Logs/Amishna Music CMS.log for details."];
            }
        });
    }] resume];
}

- (void)loadDashboard {
    if (self.hasLoadedDashboard) return;
    self.hasLoadedDashboard = YES;
    [self.webView loadRequest:[NSURLRequest requestWithURL:self.dashboardURL]];
}

- (NSFileHandle *)createLogHandle {
    NSURL *logDirectory = [NSFileManager.defaultManager.homeDirectoryForCurrentUser
        URLByAppendingPathComponent:@"Library/Logs" isDirectory:YES];
    NSURL *logURL = [logDirectory URLByAppendingPathComponent:@"Amishna Music CMS.log"];
    NSError *error = nil;
    [NSFileManager.defaultManager createDirectoryAtURL:logDirectory
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:&error];
    if (error != nil) return nil;
    if (![NSFileManager.defaultManager fileExistsAtPath:logURL.path]) {
        [NSFileManager.defaultManager createFileAtPath:logURL.path contents:nil attributes:nil];
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:logURL.path];
    [handle seekToEndOfFile];
    return handle;
}

- (void)showStartupError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Amishna Music CMS could not start";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
}

- (void)showDownloadError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Amishna Music CMS could not save the download";
    alert.informativeText = [NSString stringWithFormat:@"The file was not saved to your Downloads folder. %@", message];
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        AmishnaCMSAppDelegate *delegate = [[AmishnaCMSAppDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
