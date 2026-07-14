package com.aeromap;

import atlantafx.base.theme.PrimerDark;
import javafx.application.Application;
import javafx.fxml.FXMLLoader;
import javafx.scene.Scene;
import javafx.stage.Stage;

import javax.imageio.ImageIO;
import javax.imageio.spi.IIORegistry;
import javax.imageio.spi.ImageReaderSpi;
import java.util.Iterator;

public class App extends Application {

    @Override
    public void start(Stage stage) {
        try {
            registerImageIOPlugins();
            Application.setUserAgentStylesheet(new PrimerDark().getUserAgentStylesheet());
            showLauncher(stage);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void showLauncher(Stage stage) {
        javafx.scene.layout.VBox root = new javafx.scene.layout.VBox(20);
        root.setAlignment(javafx.geometry.Pos.CENTER);
        root.setStyle("-fx-background-color: #1e1e1e;");

        javafx.scene.control.Label title = new javafx.scene.control.Label("AeroMap GIS");
        title.setStyle("-fx-font-size: 32px; -fx-text-fill: white; -fx-font-weight: bold;");
        
        javafx.scene.control.Label subtitle = new javafx.scene.control.Label("Professional Spatial Analysis");
        subtitle.setStyle("-fx-font-size: 14px; -fx-text-fill: #aaaaaa; -fx-padding: 0 0 20 0;");

        javafx.scene.control.Button btnNew = new javafx.scene.control.Button("New Project");
        btnNew.setStyle("-fx-font-size: 16px; -fx-pref-width: 200px; -fx-cursor: hand;");
        btnNew.setOnAction(e -> startMainApp(stage, null));

        javafx.scene.control.Button btnOpen = new javafx.scene.control.Button("Open Project");
        btnOpen.setStyle("-fx-font-size: 16px; -fx-pref-width: 200px; -fx-cursor: hand;");
        btnOpen.setOnAction(e -> {
            javafx.stage.FileChooser fc = new javafx.stage.FileChooser();
            fc.setTitle("Select AeroMap Project (.amap)");
            fc.getExtensionFilters().add(new javafx.stage.FileChooser.ExtensionFilter("AeroMap Project", "*.amap"));
            java.io.File file = fc.showOpenDialog(stage);
            if (file != null && file.exists()) {
                startMainApp(stage, file);
            }
        });

        root.getChildren().addAll(title, subtitle, btnNew, btnOpen);
        Scene scene = new Scene(root, 600, 400);
        stage.setTitle("AeroMap GIS - Welcome");
        stage.setScene(scene);
        stage.show();
    }

    private void startMainApp(Stage stage, java.io.File projectFile) {
        try {
            FXMLLoader loader = new FXMLLoader(getClass().getResource("main.fxml"));
            Scene scene = new Scene(loader.load(), 1280, 720);
            
            com.aeromap.controller.MainController controller = loader.getController();
            if (projectFile != null) {
                controller.loadProject(projectFile);
            }

            stage.setTitle("AeroMap GIS Desktop" + (projectFile != null ? " - " + projectFile.getName() : ""));
            stage.setScene(scene);
        } catch (Exception e) {
            e.printStackTrace();
            javafx.scene.control.Alert alert = new javafx.scene.control.Alert(javafx.scene.control.Alert.AlertType.ERROR);
            alert.setHeaderText("Error Loading Workspace");
            alert.setContentText(e.getMessage());
            alert.show();
        }
    }


    /**
     * Forces ImageIO plugin discovery using the application classloader.
     *
     * Problem: jpackage bundles JARs in app/ and loads them via a custom classloader.
     * javax.imageio.ImageIO.scanForPlugins() uses the *system* classloader by default,
     * which doesn't see the app JARs → no TIFF reader registered → "No suitable reader".
     *
     * Fix: temporarily set the context classloader to THIS class's classloader,
     * then call scanForPlugins(). This forces discovery of all SPI entries in the
     * META-INF/services files inside jai-imageio-core-1.4.0.jar and imageio-ext-tiff-1.4.7.jar.
     */
    private void registerImageIOPlugins() {
        ClassLoader appClassLoader = getClass().getClassLoader();
        ClassLoader original = Thread.currentThread().getContextClassLoader();
        try {
            // Temporarily use app classloader so scanForPlugins() finds our JARs
            Thread.currentThread().setContextClassLoader(appClassLoader);
            ImageIO.scanForPlugins();
            System.err.println("DEBUG: ImageIO plugins scanned successfully.");
        } finally {
            Thread.currentThread().setContextClassLoader(original);
        }

        // Also try to explicitly register the TIFF SPI from jai-imageio-core
        // as a belt-and-suspenders fallback in case scanForPlugins() misses it
        tryRegisterSpi("com.github.jaiimageio.impl.plugins.tiff.TIFFImageReaderSpi");
        tryRegisterSpi("it.geosolutions.imageioimpl.plugins.tiff.TIFFImageReaderSpi");

        // Log registered TIFF readers for diagnosis
        IIORegistry registry = IIORegistry.getDefaultInstance();
        Iterator<ImageReaderSpi> iter = registry.getServiceProviders(ImageReaderSpi.class, true);
        System.err.println("DEBUG: Registered ImageIO TIFF readers:");
        while (iter.hasNext()) {
            ImageReaderSpi spi = iter.next();
            for (String suffix : spi.getFileSuffixes()) {
                if (suffix.equalsIgnoreCase("tif") || suffix.equalsIgnoreCase("tiff")) {
                    System.err.println("  -> " + spi.getClass().getName());
                    break;
                }
            }
        }
    }

    private void tryRegisterSpi(String className) {
        try {
            Class<?> spiClass = Class.forName(className, true, getClass().getClassLoader());
            ImageReaderSpi spi = (ImageReaderSpi) spiClass.getDeclaredConstructor().newInstance();
            IIORegistry.getDefaultInstance().registerServiceProvider(spi);
            System.err.println("DEBUG: Explicitly registered SPI: " + className);
        } catch (ClassNotFoundException e) {
            System.err.println("DEBUG: SPI class not found (OK if not on classpath): " + className);
        } catch (Throwable e) {
            System.err.println("DEBUG: Could not register SPI " + className + ": " + e.getMessage());
        }
    }

    public static void main(String[] args) {
        // Global GeoTools configuration — set before any class loads
        System.setProperty("org.geotools.referencing.forceXY", "true");
        System.setProperty("com.sun.media.imageio.disableNativeCode", "true");
        System.setProperty("com.sun.media.jai.disableMediaLib", "true");

        launch(args);
    }
}
