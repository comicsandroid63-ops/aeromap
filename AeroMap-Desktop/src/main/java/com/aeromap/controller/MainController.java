package com.aeromap.controller;

import com.aeromap.service.DrawingService;
import com.aeromap.service.ElevationMeshService;
import com.aeromap.service.GeoTiffService;
import com.aeromap.service.VectorService;
import com.aeromap.service.BaseMapService;
import com.aeromap.service.RasterAnalysisService;
import com.aeromap.service.LabelService;
import org.kordamp.ikonli.javafx.FontIcon;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.fxml.FXML;
import javafx.scene.canvas.Canvas;
import javafx.scene.canvas.GraphicsContext;
import javafx.scene.control.*;
import javafx.scene.control.SelectionMode;
import javafx.scene.control.SpinnerValueFactory;
import javafx.scene.control.Tooltip;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.layout.HBox;
import javafx.scene.layout.VBox;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.GridPane;
import javafx.scene.paint.Color;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.CullFace;
import javafx.scene.shape.DrawMode;
import javafx.scene.shape.MeshView;
import javafx.scene.shape.TriangleMesh;
import javafx.scene.AmbientLight;
import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.PerspectiveCamera;
import javafx.scene.PointLight;
import javafx.scene.SceneAntialiasing;
import javafx.scene.SubScene;
import javafx.scene.transform.Rotate;
import javafx.scene.transform.Translate;
import javafx.stage.FileChooser;
import org.geotools.geometry.jts.JTS;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.referencing.CRS;
import org.geotools.referencing.crs.DefaultGeographicCRS;
import org.locationtech.jts.geom.*;
import org.opengis.referencing.crs.CoordinateReferenceSystem;
import org.opengis.referencing.operation.MathTransform;
import javafx.stage.Stage;
import javafx.scene.Scene;
import javafx.collections.FXCollections;
import javafx.scene.control.cell.MapValueFactory;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;
import com.aeromap.service.ProjectService;
import com.aeromap.service.ObjImportService;

public class MainController {

    @FXML private Canvas mapCanvas;
    @FXML private StackPane mapContainer;
    @FXML private ListView<String> layerList;
    @FXML private Button btnImport;
    @FXML private Button btnSaveProject;
    @FXML private Button btnZoomIn;
    @FXML private Button btnZoomOut;
    @FXML private Label lblCoords;
    @FXML private Label lblZoom;
    @FXML private HBox topNavRight;
    @FXML private Button btnSlope;
    @FXML private Button btnAspect;
    @FXML private Button btnHillshade;
    @FXML private Button btnHydrology;
    @FXML private Button btnMultiHillshade;
    @FXML private Button btnFlowAccum;
    @FXML private Button btnTRI;
    @FXML private Button btnCurvature;
    @FXML private Button btnContours;
    @FXML private Button btnViewshed;
    @FXML private Button btnBuffer;
    @FXML private Button btnClip;
    @FXML private Button btnHeatmap;
    @FXML private Button btnUnion;
    @FXML private Button btnErase;
    @FXML private Button btnDissolve;
    @FXML private Button btnSimplify;
    @FXML private Button btnCentroids;
    @FXML private Button btnConvexHull;
    @FXML private Button btnVoronoi;

    private final GeoTiffService tiffService = new GeoTiffService();
    private final VectorService vectorService = new VectorService();
    private final ProjectService projectService = new ProjectService();
    private final BaseMapService baseMapService = new BaseMapService();
    private final ElevationMeshService elevationMeshService = new ElevationMeshService();
    private final ObjImportService objImportService = new ObjImportService();
    private final RasterAnalysisService analysisService = new RasterAnalysisService();
    private final LabelService labelService = new LabelService();
    private final java.util.Map<VectorService.VectorData, LabelService.LabelConfig> labelConfigs = new java.util.HashMap<>();
    private boolean showBaseMap = false;
    private boolean is3DMode = false;
    
    private final List<VectorService.VectorData> vectorLayers = new ArrayList<>();
    private final List<GeoTiffService.RasterData> rasterLayers = new ArrayList<>();
    private final java.util.HashMap<VectorService.VectorData, String> vectorNames = new java.util.HashMap<>();

    private CoordinateReferenceSystem masterCRS = DefaultGeographicCRS.WGS84;
    private ReferencedEnvelope viewport = new ReferencedEnvelope(-10, 10, -10, 10, DefaultGeographicCRS.WGS84);
    
    // Optimization Cache
    private javafx.scene.image.WritableImage canvasCache;
    private ReferencedEnvelope cacheViewport;
    private boolean isDragging = false;
    
    private javafx.animation.Timeline hqTimer;
    private Canvas offscreenBuffer;
    private volatile boolean newTilesDuringDrag = false;
    
    private final Map<String, javafx.scene.image.Image> tileCache = new ConcurrentHashMap<>();
    private final Set<String> pendingTiles = ConcurrentHashMap.newKeySet();
    private boolean drawPending = false;
    private final Set<String> hiddenLayers = new HashSet<>();
    private final ExecutorService tileExecutor = Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors() * 2);
    private static final int TILE_SIZE = 256;

    private final DrawingService drawingService = new DrawingService();
    private double cursorWorldX;
    private double cursorWorldY;
    private int drawingCounter = 0;
    private ToggleButton btnDrawLine;
    private ToggleButton btnDrawPolygon;
    private ToggleButton btnDrawGroup;
    private Button btnFinishDrawing;
    private Button btnCancelDrawing;
    private double[] panAnchor = new double[2];

    // 3D View
    private SubScene scene3D;
    private Group world3D;
    private PerspectiveCamera camera3D;
    private Rotate rotateX, rotateY;
    private Translate translateCam;
    private double mouseOldX, mouseOldY;
    private float verticalExaggeration = 2.0f;
    private int meshResolution = 500;
    private final List<ImportedModel> importedModels = new ArrayList<>();
    @FXML private ToggleButton btn2DView;
    @FXML private ToggleButton btn3DView;
    @FXML private Slider exaggerationSlider3D;
    @FXML private TextField txtExaggeration3D;
    @FXML private Spinner<Integer> resolutionSpinner3D;
    @FXML private Button btnExportOBJ;
    @FXML private Button btnTiffToOBJ;
    @FXML private Button btnImportOBJ;
    @FXML private Slider verticalExaggerationSlider;
    @FXML private Label lblVerticalExaggeration;

    @FXML
    public void initialize() {
        // FORCE X,Y (Longitude, Latitude) axis order globally
        System.setProperty("org.geotools.referencing.forceXY", "true");
        org.geotools.util.factory.Hints.putSystemDefault(org.geotools.util.factory.Hints.FORCE_LONGITUDE_FIRST_AXIS_ORDER, Boolean.TRUE);

        mapCanvas.widthProperty().bind(mapContainer.widthProperty());
        mapCanvas.heightProperty().bind(mapContainer.heightProperty());
        mapCanvas.widthProperty().addListener(e -> drawMap(false));
        mapCanvas.heightProperty().addListener(e -> drawMap(false));

        hqTimer = new javafx.animation.Timeline(new javafx.animation.KeyFrame(javafx.util.Duration.millis(300), e -> {
            isDragging = false;
            if (newTilesDuringDrag) {
                newTilesDuringDrag = false;
            }
            drawMap(false);
        }));
        hqTimer.setCycleCount(1);

        btnImport.setOnAction(e -> handleImport());
        btnImport.setText("Import Data (GIS)");
        
        if (btnSaveProject != null) {
            btnSaveProject.setOnAction(e -> saveProject());
        }
        setupLayerList();
        setupBasemapToggle();
        setupInteractivity();
        setupFloatingToolbar();
        setupDrawingHandlers();
        
        // Setup handlers for FXML-injected view buttons
        if (btn2DView != null) btn2DView.setOnAction(e -> switchTo2D());
        if (btn3DView != null) btn3DView.setOnAction(e -> {
            if (!is3DMode) switchTo3D();
        });

        setupTerrainAnalysisHandlers();
        setupVerticalExaggerationSlider();
        setup3DExaggerationSlider();
        setupResolutionSpinner();
        setupExportOBJ();
        setupTiffToOBJ();
        setupImportOBJ();

        drawMap(false);
    }

    private void setupBasemapToggle() {
        CheckBox chk = new CheckBox("Base Map (OpenStreetMap)");
        chk.setStyle("-fx-text-fill: white; -fx-padding: 5 10 5 10;");
        chk.selectedProperty().addListener((o, a, val) -> {
            showBaseMap = val;
            if (val) {
                baseMapService.setOnTileLoaded(() -> {
                    if (isDragging) {
                        newTilesDuringDrag = true;
                        return;
                    }
                    if (!drawPending) {
                        drawPending = true;
                        javafx.application.Platform.runLater(() -> { 
                            drawMap(false); 
                            drawPending = false; 
                        });
                    }
                });
            }
            drawMap(false);
        });
        VBox parent = (VBox) layerList.getParent();
        parent.getChildren().add(parent.getChildren().indexOf(layerList), chk);
    }

    private void setupLayerList() {
        layerList.setCellFactory(lv -> new ListCell<String>() {
            private final CheckBox check = new CheckBox();
            private final HBox box = new HBox(8, check);
            { box.setAlignment(javafx.geometry.Pos.CENTER_LEFT); }
            @Override
            protected void updateItem(String item, boolean empty) {
                super.updateItem(item, empty);
                if (empty || item == null) {
                    setGraphic(null);
                    setText(null);
                } else {
                    check.setSelected(!hiddenLayers.contains(item));
                    check.selectedProperty().addListener((o, a, val) -> {
                        if (val) hiddenLayers.remove(item); else hiddenLayers.add(item);
                        drawMap(false);
                    });
                    if (box.getChildren().size() < 2) box.getChildren().add(new Label(item));
                    else ((Label) box.getChildren().get(1)).setText(item);
                    setGraphic(box);
                    setText(null);
                    
                    // Left-click shows color selector for both raster and vector
                    setOnMouseClicked(e -> {
                        if (e.getButton() == javafx.scene.input.MouseButton.PRIMARY) {
                            if (item.contains("[Raster]")) {
                                showColorSchemePopup(item, e.getScreenX(), e.getScreenY());
                            } else if (item.contains("[Vector]")) {
                                showVectorColorPopup(item, e.getScreenX(), e.getScreenY());
                            }
                        }
                    });
                    
                    // Right-click context menu
                    ContextMenu menu = new ContextMenu();
                    MenuItem zoom = new MenuItem("Center Map on Layer");
                    zoom.setOnAction(e -> zoomToLayer(item));
                    
                    MenuItem changeCRS = new MenuItem("Change CRS / Projection");
                    changeCRS.setOnAction(e -> {
                        CoordinateReferenceSystem selected = showCRSSelectionDialog(item);
                        if (selected != null) {
                            reprojectLayer(item, selected);
                        }
                    });

                    if (item.contains("[Raster]")) {
                        menu.getItems().addAll(zoom, changeCRS, new SeparatorMenuItem(), buildColorSchemeMenu(item));
                    } else if (item.contains("[Vector]")) {
                        MenuItem attrItem = new MenuItem("Open Attribute Table");
                        attrItem.setOnAction(e -> {
                            VectorService.VectorData v = getSelectedVectorData(item);
                            if (v != null) openAttributeTable(v, vectorNames.get(v));
                        });
                        MenuItem labelItem = new MenuItem("Configure Labels...");
                        labelItem.setOnAction(e -> showLabelConfigDialog(item));
                        MenuItem clearLabelsItem = new MenuItem("Clear Labels");
                        clearLabelsItem.setOnAction(e -> {
                            VectorService.VectorData v = getSelectedVectorData(item);
                            if (v != null) {
                                labelConfigs.remove(v);
                                v.labelConfig = null;
                                drawMap(false);
                            }
                        });
                        menu.getItems().addAll(zoom, changeCRS, new SeparatorMenuItem(), buildVectorColorMenu(item), attrItem, new SeparatorMenuItem(), labelItem, clearLabelsItem);
                    } else {
                        menu.getItems().addAll(zoom, changeCRS);
                    }
                    setContextMenu(menu);
                }
            }
        });

        layerList.setOnDragDetected(e -> {
            String selected = layerList.getSelectionModel().getSelectedItem();
            if (selected == null) return;
            javafx.scene.input.ClipboardContent content = new javafx.scene.input.ClipboardContent();
            content.putString(selected);
            javafx.scene.input.Dragboard db = layerList.startDragAndDrop(javafx.scene.input.TransferMode.MOVE);
            db.setContent(content);
            e.consume();
        });
        layerList.setOnDragOver(e -> {
            if (e.getGestureSource() != layerList) return;
            e.acceptTransferModes(javafx.scene.input.TransferMode.MOVE);
            e.consume();
        });
        layerList.setOnDragDropped(e -> {
            javafx.scene.input.Dragboard db = e.getDragboard();
            if (!db.hasString()) return;
            String draggedItem = db.getString();
            int fromIdx = layerList.getItems().indexOf(draggedItem);
            if (fromIdx < 0) return;
            double y = e.getY();
            double cellH = layerList.getHeight() / Math.max(layerList.getItems().size(), 1);
            int toIdx = Math.max(0, Math.min((int) (y / cellH), layerList.getItems().size()));
            if (toIdx >= layerList.getItems().size()) toIdx = layerList.getItems().size() - 1;
            layerList.getItems().remove(fromIdx);
            if (toIdx > fromIdx) toIdx--;
            layerList.getItems().add(toIdx, draggedItem);
            syncLayerOrder();
            drawMap(false);
            e.setDropCompleted(true);
            e.consume();
        });
    }

    private void syncLayerOrder() {
        String rasterPrefix = "[Raster] ";
        java.util.List<GeoTiffService.RasterData> reordered = new ArrayList<>();
        for (String item : layerList.getItems()) {
            if (item.startsWith(rasterPrefix)) {
                String name = item.substring(rasterPrefix.length());
                for (GeoTiffService.RasterData r : rasterLayers) {
                    if (r.name.equals(name) && !reordered.contains(r)) {
                        reordered.add(r); break;
                    }
                }
            }
        }
        for (GeoTiffService.RasterData r : rasterLayers) if (!reordered.contains(r)) reordered.add(r);
        rasterLayers.clear(); rasterLayers.addAll(reordered);
    }

    private void toggleColor(String name) {
        if (name == null) return;
        if (name.contains("[Raster]")) {
            for (GeoTiffService.RasterData r : rasterLayers) {
                if (name.contains(r.name)) {
                    r.isColorized = !r.isColorized;
                    tileCache.clear();
                    requestDraw();
                    break;
                }
            }
        }
    }

    private void setColorScheme(String name, GeoTiffService.ColorScheme scheme) {
        if (name == null) return;
        if (name.contains("[Raster]")) {
            for (GeoTiffService.RasterData r : rasterLayers) {
                if (name.contains(r.name)) {
                    r.colorScheme = scheme;
                    r.isColorized = true;
                    tileCache.clear();
                    requestDraw();
                    break;
                }
            }
        }
    }

    private void showColorSchemePopup(String item, double screenX, double screenY) {
        javafx.stage.Popup popup = new javafx.stage.Popup();
        popup.setAutoHide(true);
        popup.setHideOnEscape(true);

        VBox content = new VBox(4);
        content.setStyle("-fx-background-color: #2b2b2b; -fx-border-color: #555; -fx-border-width: 1; -fx-padding: 8; -fx-background-radius: 4;");
        content.setMaxHeight(400);

        javafx.scene.control.ScrollPane scroll = new javafx.scene.control.ScrollPane(content);
        scroll.setFitToWidth(true);
        scroll.setPrefWidth(280);
        scroll.setMaxHeight(400);
        scroll.setStyle("-fx-background: #2b2b2b; -fx-background-color: #2b2b2b;");

        javafx.scene.control.Label title = new javafx.scene.control.Label("Select Color Scheme");
        title.setStyle("-fx-text-fill: white; -fx-font-weight: bold; -fx-padding: 0 0 4 0;");
        content.getChildren().add(title);

        // Helper to add scheme option
        java.util.function.Consumer<GeoTiffService.ColorScheme> addOption = scheme -> {
            javafx.scene.control.Label label = new javafx.scene.control.Label(scheme.getDisplayName());
            label.setStyle("-fx-text-fill: #ddd; -fx-padding: 4 8 4 8; -fx-cursor: hand;");
            label.setOnMouseEntered(e -> label.setStyle("-fx-text-fill: #fff; -fx-background-color: #3c3c3c; -fx-padding: 4 8 4 8; -fx-cursor: hand;"));
            label.setOnMouseExited(e -> label.setStyle("-fx-text-fill: #ddd; -fx-padding: 4 8 4 8; -fx-cursor: hand;"));
            label.setOnMouseClicked(e -> {
                setColorScheme(item, scheme);
                popup.hide();
            });
            content.getChildren().add(label);
        };

        // Simple
        javafx.scene.control.Label simpleCat = new javafx.scene.control.Label("SIMPLE");
        simpleCat.setStyle("-fx-text-fill: #888; -fx-font-size: 10; -fx-padding: 4 0 2 4;");
        content.getChildren().add(simpleCat);
        addOption.accept(GeoTiffService.ColorScheme.GRAYSCALE);
        addOption.accept(GeoTiffService.ColorScheme.ELEVATION);

        // Scientific
        javafx.scene.control.Label sciCat = new javafx.scene.control.Label("SCIENTIFIC");
        sciCat.setStyle("-fx-text-fill: #888; -fx-font-size: 10; -fx-padding: 4 0 2 4;");
        content.getChildren().add(sciCat);
        for (GeoTiffService.ColorScheme s : new GeoTiffService.ColorScheme[]{
            GeoTiffService.ColorScheme.VIRIDIS, GeoTiffService.ColorScheme.PLASMA,
            GeoTiffService.ColorScheme.INFERNO, GeoTiffService.ColorScheme.MAGMA,
            GeoTiffService.ColorScheme.CIVIDIS, GeoTiffService.ColorScheme.TURBO
        }) addOption.accept(s);

        // Nature
        javafx.scene.control.Label natCat = new javafx.scene.control.Label("NATURE");
        natCat.setStyle("-fx-text-fill: #888; -fx-font-size: 10; -fx-padding: 4 0 2 4;");
        content.getChildren().add(natCat);
        for (GeoTiffService.ColorScheme s : new GeoTiffService.ColorScheme[]{
            GeoTiffService.ColorScheme.OCEAN, GeoTiffService.ColorScheme.FOREST,
            GeoTiffService.ColorScheme.FIRE, GeoTiffService.ColorScheme.EARTH,
            GeoTiffService.ColorScheme.RAINBOW
        }) addOption.accept(s);

        // Cinematic
        javafx.scene.control.Label cinCat = new javafx.scene.control.Label("CINEMATIC");
        cinCat.setStyle("-fx-text-fill: #888; -fx-font-size: 10; -fx-padding: 4 0 2 4;");
        content.getChildren().add(cinCat);
        for (GeoTiffService.ColorScheme s : new GeoTiffService.ColorScheme[]{
            GeoTiffService.ColorScheme.CINEMATIC_WARM, GeoTiffService.ColorScheme.CINEMATIC_COOL,
            GeoTiffService.ColorScheme.CINEMATIC_TEAL_ORANGE, GeoTiffService.ColorScheme.CINEMATIC_NOIR,
            GeoTiffService.ColorScheme.CINEMATIC_VINTAGE, GeoTiffService.ColorScheme.CINEMATIC_BLOCKBUSTER,
            GeoTiffService.ColorScheme.CINEMATIC_DRAMATIC
        }) addOption.accept(s);

        popup.getContent().add(scroll);
        popup.show(layerList.getScene().getWindow(), screenX, screenY);
    }

    private Menu buildColorSchemeMenu(String item) {
        Menu colorMenu = new Menu("Color Scheme");

        MenuItem grayscaleItem = new MenuItem(GeoTiffService.ColorScheme.GRAYSCALE.getDisplayName());
        grayscaleItem.setOnAction(e -> setColorScheme(item, GeoTiffService.ColorScheme.GRAYSCALE));

        MenuItem elevationItem = new MenuItem(GeoTiffService.ColorScheme.ELEVATION.getDisplayName());
        elevationItem.setOnAction(e -> setColorScheme(item, GeoTiffService.ColorScheme.ELEVATION));

        Menu scientificMenu = new Menu("Scientific");
        for (GeoTiffService.ColorScheme scheme : new GeoTiffService.ColorScheme[]{
            GeoTiffService.ColorScheme.VIRIDIS, GeoTiffService.ColorScheme.PLASMA,
            GeoTiffService.ColorScheme.INFERNO, GeoTiffService.ColorScheme.MAGMA,
            GeoTiffService.ColorScheme.CIVIDIS, GeoTiffService.ColorScheme.TURBO
        }) {
            MenuItem sciItem = new MenuItem(scheme.getDisplayName());
            sciItem.setOnAction(e -> setColorScheme(item, scheme));
            scientificMenu.getItems().add(sciItem);
        }

        Menu natureMenu = new Menu("Nature");
        for (GeoTiffService.ColorScheme scheme : new GeoTiffService.ColorScheme[]{
            GeoTiffService.ColorScheme.OCEAN, GeoTiffService.ColorScheme.FOREST,
            GeoTiffService.ColorScheme.FIRE, GeoTiffService.ColorScheme.EARTH
        }) {
            MenuItem natItem = new MenuItem(scheme.getDisplayName());
            natItem.setOnAction(e -> setColorScheme(item, scheme));
            natureMenu.getItems().add(natItem);
        }

        Menu cinematicMenu = new Menu("Cinematic");
        for (GeoTiffService.ColorScheme scheme : new GeoTiffService.ColorScheme[]{
            GeoTiffService.ColorScheme.CINEMATIC_WARM, GeoTiffService.ColorScheme.CINEMATIC_COOL,
            GeoTiffService.ColorScheme.CINEMATIC_TEAL_ORANGE, GeoTiffService.ColorScheme.CINEMATIC_NOIR,
            GeoTiffService.ColorScheme.CINEMATIC_VINTAGE, GeoTiffService.ColorScheme.CINEMATIC_BLOCKBUSTER,
            GeoTiffService.ColorScheme.CINEMATIC_DRAMATIC
        }) {
            MenuItem cinItem = new MenuItem(scheme.getDisplayName());
            cinItem.setOnAction(e -> setColorScheme(item, scheme));
            cinematicMenu.getItems().add(cinItem);
        }

        MenuItem rainbowItem = new MenuItem(GeoTiffService.ColorScheme.RAINBOW.getDisplayName());
        rainbowItem.setOnAction(e -> setColorScheme(item, GeoTiffService.ColorScheme.RAINBOW));

        colorMenu.getItems().addAll(grayscaleItem, elevationItem, new SeparatorMenuItem(),
            scientificMenu, natureMenu, cinematicMenu, new SeparatorMenuItem(), rainbowItem);
        return colorMenu;
    }

    private void setVectorColor(String name, Color color) {
        setVectorProperties(name, color, null);
    }

    private void setVectorProperties(String name, Color strokeColor, Color fillColor) {
        if (name == null) return;
        if (name.contains("[Vector]")) {
            for (VectorService.VectorData v : vectorLayers) {
                String vName = vectorNames.get(v);
                if (vName != null && name.contains(vName)) {
                    if (strokeColor != null) v.color = strokeColor;
                    if (fillColor != null) v.fillColor = fillColor;
                    requestDraw();
                    break;
                }
            }
        }
    }

    private void showVectorColorPopup(String item, double screenX, double screenY) {
        javafx.stage.Popup popup = new javafx.stage.Popup();
        popup.setAutoHide(true);
        popup.setHideOnEscape(true);

        VBox content = new VBox(8);
        content.setStyle("-fx-background-color: #2b2b2b; -fx-border-color: #555; -fx-border-width: 1; -fx-padding: 10; -fx-background-radius: 4;");

        Label title = new Label("Vector Style");
        title.setStyle("-fx-text-fill: white; -fx-font-weight: bold;");
        content.getChildren().add(title);

        VectorService.VectorData target = getSelectedVectorData(item);
        if (target == null) return;
        
        final VectorService.VectorData finalTarget = target;

        Label lineLabel = new Label("Line Color & Opacity:");
        lineLabel.setStyle("-fx-text-fill: white; -fx-font-size: 11;");
        javafx.scene.control.ColorPicker lineColorPicker = new javafx.scene.control.ColorPicker(finalTarget.color);
        lineColorPicker.setStyle("-fx-background-color: #3c3c3c; -fx-text-fill: white; -fx-border-color: #555;");
        lineColorPicker.setMaxWidth(Double.MAX_VALUE);
        
        javafx.scene.control.Slider lineOpacity = new javafx.scene.control.Slider(0, 1, finalTarget.color.getOpacity());
        lineOpacity.valueProperty().addListener((o, oldVal, newVal) -> {
            Color c = finalTarget.color;
            setVectorProperties(item, new Color(c.getRed(), c.getGreen(), c.getBlue(), newVal.doubleValue()), null);
        });
        lineColorPicker.setOnAction(e -> {
            Color c = lineColorPicker.getValue();
            setVectorProperties(item, new Color(c.getRed(), c.getGreen(), c.getBlue(), lineOpacity.getValue()), null);
        });

        Label fillLabel = new Label("Fill Color & Opacity:");
        fillLabel.setStyle("-fx-text-fill: white; -fx-font-size: 11;");
        javafx.scene.control.ColorPicker fillColorPicker = new javafx.scene.control.ColorPicker(finalTarget.fillColor);
        fillColorPicker.setStyle("-fx-background-color: #3c3c3c; -fx-text-fill: white; -fx-border-color: #555;");
        fillColorPicker.setMaxWidth(Double.MAX_VALUE);

        javafx.scene.control.Slider fillOpacity = new javafx.scene.control.Slider(0, 1, finalTarget.fillColor.getOpacity());
        fillOpacity.valueProperty().addListener((o, oldVal, newVal) -> {
            Color c = finalTarget.fillColor;
            setVectorProperties(item, null, new Color(c.getRed(), c.getGreen(), c.getBlue(), newVal.doubleValue()));
        });
        fillColorPicker.setOnAction(e -> {
            Color c = fillColorPicker.getValue();
            setVectorProperties(item, null, new Color(c.getRed(), c.getGreen(), c.getBlue(), fillOpacity.getValue()));
        });

        javafx.scene.control.Separator sep = new javafx.scene.control.Separator();
        sep.setStyle("-fx-background: #555;");

        Button btnAttr = new Button("Open Attribute Table");
        btnAttr.setStyle("-fx-background-color: #00a8ff; -fx-text-fill: white; -fx-font-weight: bold; -fx-cursor: hand;");
        btnAttr.setMaxWidth(Double.MAX_VALUE);
        btnAttr.setOnAction(e -> {
            popup.hide();
            openAttributeTable(finalTarget, vectorNames.get(finalTarget));
        });

        content.getChildren().addAll(lineLabel, lineColorPicker, lineOpacity, sep, fillLabel, fillColorPicker, fillOpacity, new Separator(), btnAttr);

        popup.getContent().add(content);
        popup.show(layerList.getScene().getWindow(), screenX, screenY);
    }

    private Menu buildVectorColorMenu(String item) {
        Menu colorMenu = new Menu("Color");

        MenuItem customItem = new MenuItem("Custom Color...");
        customItem.setOnAction(e -> showCustomVectorColorDialog(item));
        customItem.setStyle("-fx-font-weight: bold;");
        colorMenu.getItems().add(customItem);
        colorMenu.getItems().add(new SeparatorMenuItem());

        java.util.Map<String, Color> colors = new java.util.LinkedHashMap<>();
        colors.put("Lime", Color.LIME);
        colors.put("Red", Color.RED);
        colors.put("Orange", Color.ORANGE);
        colors.put("Yellow", Color.YELLOW);
        colors.put("Cyan", Color.CYAN);
        colors.put("Blue", Color.BLUE);
        colors.put("Magenta", Color.MAGENTA);
        colors.put("White", Color.WHITE);
        colors.put("Green", Color.GREEN);
        colors.put("Purple", Color.PURPLE);
        colors.put("Pink", Color.PINK);
        colors.put("Teal", Color.TEAL);
        colors.put("Brown", Color.BROWN);
        colors.put("Gray", Color.GRAY);

        for (java.util.Map.Entry<String, Color> entry : colors.entrySet()) {
            MenuItem ci = new MenuItem(entry.getKey());
            ci.setOnAction(e -> setVectorColor(item, entry.getValue()));
            colorMenu.getItems().add(ci);
        }

        return colorMenu;
    }

    private void showCustomVectorColorDialog(String item) {
        javafx.stage.Stage stage = (javafx.stage.Stage) layerList.getScene().getWindow();
        javafx.scene.control.ColorPicker picker = new javafx.scene.control.ColorPicker(Color.LIME);
        javafx.scene.control.Dialog<Color> dialog = new javafx.scene.control.Dialog<>();
        dialog.initOwner(stage);
        dialog.setTitle("Custom Color");
        dialog.setHeaderText("Select a color for the vector layer");
        dialog.getDialogPane().setContent(picker);
        javafx.scene.control.ButtonType ok = javafx.scene.control.ButtonType.OK;
        javafx.scene.control.ButtonType cancel = javafx.scene.control.ButtonType.CANCEL;
        dialog.getDialogPane().getButtonTypes().addAll(ok, cancel);
        dialog.setResultConverter(btn -> btn == ok ? picker.getValue() : null);
        dialog.showAndWait().ifPresent(color -> {
            if (color != null) setVectorColor(item, color);
        });
    }

    private void zoomToLayer(String itemLabel) {
        if (itemLabel == null) return;
        ReferencedEnvelope env = null;
        if (itemLabel.contains("[Raster]")) {
            GeoTiffService.RasterData rd = getSelectedRasterData(itemLabel);
            if (rd != null) env = rd.envelope;
        } else if (itemLabel.contains("[Vector]")) {
            VectorService.VectorData vd = getSelectedVectorData(itemLabel);
            if (vd != null) env = vd.envelope;
        }
        
        if (env != null) {
            org.opengis.referencing.crs.CoordinateReferenceSystem envCRS = env.getCoordinateReferenceSystem();
            ReferencedEnvelope masterEnv = env;
            if (envCRS != null && !envCRS.equals(masterCRS)) {
                try {
                    MathTransform t = CRS.findMathTransform(envCRS, masterCRS, true);
                    masterEnv = new ReferencedEnvelope(JTS.transform(env, t), masterCRS);
                } catch (Exception e) {}
            }
            viewport = new ReferencedEnvelope(masterEnv);
            // Apply a nice margin
            double marginW = viewport.getWidth() * 0.15;
            double marginH = viewport.getHeight() * 0.15;
            viewport.expandBy(marginW, marginH);
            fixAspectRatio();
            drawMap(false);
            if (is3DMode) {
                rebuild3DContent();
            }
        }
    }

    private void fixAspectRatio() {
        double w = mapCanvas.getWidth(), h = mapCanvas.getHeight();
        if (w <= 0 || h <= 0 || viewport == null) return;
        double canvasRatio = h / w;
        double viewWidth = viewport.getWidth();
        double centerLookX = viewport.getMedian(0), centerLookY = viewport.getMedian(1);
        double targetHeight = viewWidth * canvasRatio;
        viewport = new ReferencedEnvelope(centerLookX - viewWidth/2.0, centerLookX + viewWidth/2.0, centerLookY - targetHeight/2.0, centerLookY + targetHeight/2.0, masterCRS);
    }

    public void loadProject(File projectFile) {
        try {
            if (!projectFile.exists()) return;
            
            File projectDir = projectFile.getParentFile();
            ProjectService.ProjectMetadata meta = projectService.loadProjectMeta(projectFile);
            if (meta.masterCRSCode != null) {
                try {
                    masterCRS = org.geotools.referencing.CRS.parseWKT(meta.masterCRSCode);
                } catch (Exception ex) {
                    try {
                        masterCRS = org.geotools.referencing.CRS.decode(meta.masterCRSCode);
                    } catch (Exception ex2) {
                        masterCRS = org.geotools.referencing.crs.DefaultGeographicCRS.WGS84;
                    }
                }
            }

            for (ProjectService.LayerMeta lm : meta.vectorLayers) {
                File shpFile = new File(projectDir, lm.relativePath);
                if (shpFile.exists()) {
                    VectorService.VectorData v = vectorService.loadShapefile(shpFile);
                    if (lm.color != null) v.color = javafx.scene.paint.Color.web(lm.color);
                    if (lm.fillColor != null) v.fillColor = javafx.scene.paint.Color.web(lm.fillColor);
                    addVectorLayer(v, lm.name);
                }
            }

            // Zoom to first loaded layer to initialize viewport
            if (!layerList.getItems().isEmpty()) {
                zoomToLayer(layerList.getItems().get(layerList.getItems().size() - 1));
            }
            
            drawMap(false);
        } catch (Exception e) {
            e.printStackTrace();
            showAlert("Error Loading Project", "Could not load project data: " + e.getMessage());
        }
    }

    private void saveProject() {
        FileChooser fc = new FileChooser();
        fc.setTitle("Save AeroMap Project");
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("AeroMap Project", "*.amap"));
        File file = fc.showSaveDialog(mapCanvas.getScene().getWindow());
        if (file == null) return;
        
        File dir = file.getParentFile();
        String projectName = file.getName();
        if (projectName.toLowerCase().endsWith(".amap")) {
            projectName = projectName.substring(0, projectName.length() - 5);
        }

        final String finalProjectName = projectName;
        tileExecutor.submit(() -> {
            Platform.runLater(() -> {
                btnSaveProject.setText("Saving...");
                btnSaveProject.setDisable(true);
            });
            try {
                projectService.saveProject(dir, file, finalProjectName, masterCRS, vectorLayers, vectorNames, rasterLayers);
                Platform.runLater(() -> showAlert("Project Saved", "Project successfully saved to " + file.getAbsolutePath()));
            } catch (Exception e) {
                e.printStackTrace();
                Platform.runLater(() -> showAlert("Error", "Could not save project: " + e.getMessage()));
            } finally {
                Platform.runLater(() -> {
                    btnSaveProject.setText("Save Project");
                    btnSaveProject.setDisable(false);
                });
            }
        });
    }

    private void handleImport() {
        FileChooser fc = new FileChooser();
        fc.setTitle("Select GIS Data");
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("GIS Files", "*.tif", "*.tiff", "*.shp", "*.zip"));
        File file = fc.showOpenDialog(btnImport.getScene().getWindow());
        if (file != null) {
            String filename = file.getName().toLowerCase();
            if (filename.endsWith(".zip")) {
                handleZipImport(file);
            } else {
                importSingleFile(file);
            }
        }
    }

    private void importSingleFile(File file) {
        btnImport.setDisable(true); btnImport.setText("Loading...");
        new Thread(() -> {
            try {
                String filename = file.getName();
                if (filename.toLowerCase().endsWith(".tif") || filename.toLowerCase().endsWith(".tiff")) {
                    GeoTiffService.RasterData data = tiffService.loadTiff(file);
                    Platform.runLater(() -> {
                        try { 
                            CoordinateReferenceSystem crs = data.envelope.getCoordinateReferenceSystem();
                            
                            // Show detected info to user
                            String crsName = (crs != null) ? crs.getName().getCode() : "UNKNOWN";
                            String bounds = String.format("MinX: %.2f, MaxX: %.2f\nMinY: %.2f, MaxY: %.2f", 
                                data.envelope.getMinX(), data.envelope.getMaxX(), 
                                data.envelope.getMinY(), data.envelope.getMaxY());
                            
                            showAlert("GeoTIFF Information", 
                                "File: " + file.getName() + "\n" +
                                "CRS: " + crsName + "\n\n" +
                                "Bounds:\n" + bounds);

                            if (crs == null) {
                                CoordinateReferenceSystem selected = showCRSSelectionDialog(data.name);
                                if (selected != null) {
                                    // Manually set CRS if missing
                                    data.envelope = new ReferencedEnvelope(data.envelope, selected);
                                }
                            }
                            processRasterLayer(data); 
                            zoomToLayer("[Raster] " + data.name); 
                            drawMap(false); 
                        } catch (Exception ex) {
                            showError("Error processing raster", ex.getMessage());
                        } finally {
                            btnImport.setDisable(false); btnImport.setText("Import Data (GIS)");
                        }
                    });
                } else if (filename.toLowerCase().endsWith(".shp")) {
                    VectorService.VectorData data = vectorService.loadShapefile(file);
                    Platform.runLater(() -> {
                        try { 
                            if (data.crs == null) {
                                CoordinateReferenceSystem selected = showCRSSelectionDialog(filename);
                                if (selected != null) data.crs = selected;
                            }
                            processVectorLayer(data, filename); 
                            zoomToLayer("[Vector] " + filename); 
                            drawMap(false); 
                        } catch (Exception ex) {
                            showError("Error processing vector", ex.getMessage());
                        }
                    });
                }
            } catch (Throwable ex) {
                Platform.runLater(() -> showError("Import Error", ex.getMessage()));
            } finally {
                Platform.runLater(() -> { btnImport.setDisable(false); btnImport.setText("Import Layer"); });
            }
        }).start();
    }

    private void handleZipImport(File zipFile) {
        btnImport.setDisable(true); btnImport.setText("Scanning ZIP...");
        new Thread(() -> {
            List<String> layerEntries = new ArrayList<>();
            try (ZipFile zf = new ZipFile(zipFile)) {
                Enumeration<? extends ZipEntry> entries = zf.entries();
                while (entries.hasMoreElements()) {
                    ZipEntry entry = entries.nextElement();
                    if (entry.isDirectory()) continue;
                    String name = entry.getName().toLowerCase();
                    if (name.endsWith(".shp") || name.endsWith(".tif") || name.endsWith(".tiff")) {
                        layerEntries.add(entry.getName());
                    }
                }
            } catch (Exception ex) {
                Platform.runLater(() -> {
                    showError("ZIP Error", "Could not read ZIP file: " + ex.getMessage());
                    btnImport.setDisable(false); btnImport.setText("Import Data (GIS)");
                });
                return;
            }

            if (layerEntries.isEmpty()) {
                Platform.runLater(() -> {
                    showError("ZIP Import", "No compatible GIS files (.shp, .tif) found in ZIP.");
                    btnImport.setDisable(false); btnImport.setText("Import Data (GIS)");
                });
                return;
            }

            Platform.runLater(() -> {
                List<String> selectedEntries = showEntrySelectionDialog(layerEntries);
                if (selectedEntries != null && !selectedEntries.isEmpty()) {
                    btnImport.setText("Extracting...");
                    new Thread(() -> {
                        try (ZipFile zf = new ZipFile(zipFile)) {
                            Path tempDir = Files.createTempDirectory("aeromap_import_");
                            for (String entryName : selectedEntries) {
                                List<String> toExtract = new ArrayList<>();
                                toExtract.add(entryName);
                                
                                if (entryName.toLowerCase().endsWith(".shp")) {
                                    String base = entryName.substring(0, entryName.length() - 4);
                                    String[] deps = {".dbf", ".shx", ".prj", ".cpg", ".qpj"};
                                    Enumeration<? extends ZipEntry> e2 = zf.entries();
                                    while (e2.hasMoreElements()) {
                                        ZipEntry ze = e2.nextElement();
                                        String zen = ze.getName();
                                        for (String d : deps) {
                                            if (zen.equalsIgnoreCase(base + d)) {
                                                toExtract.add(zen);
                                                break;
                                            }
                                        }
                                    }
                                }

                                File mainFile = null;
                                for (String te : toExtract) {
                                    ZipEntry ze = zf.getEntry(te);
                                    if (ze == null) continue;
                                    File outFile = new File(tempDir.toFile(), ze.getName());
                                    outFile.getParentFile().mkdirs();
                                    try (InputStream is = zf.getInputStream(ze);
                                         FileOutputStream fos = new FileOutputStream(outFile)) {
                                        byte[] buf = new byte[8192];
                                        int l;
                                        while ((l = is.read(buf)) > 0) fos.write(buf, 0, l);
                                    }
                                    if (te.equals(entryName)) mainFile = outFile;
                                }
                                
                                if (mainFile != null) {
                                    final File fMain = mainFile;
                                    Platform.runLater(() -> importSingleFile(fMain));
                                }
                            }
                        } catch (Exception ex) {
                            Platform.runLater(() -> showError("Extraction Error", ex.getMessage()));
                        } finally {
                            Platform.runLater(() -> { btnImport.setDisable(false); btnImport.setText("Import Data (GIS)"); });
                        }
                    }).start();
                } else {
                    btnImport.setDisable(false); btnImport.setText("Import Data (GIS)");
                }
            });
        }).start();
    }

    private List<String> showEntrySelectionDialog(List<String> entries) {
        Dialog<List<String>> dialog = new Dialog<>();
        dialog.setTitle("Select Layers to Import");
        dialog.setHeaderText("Choose which layers to extract from ZIP:");
        
        VBox vbox = new VBox(10);
        vbox.setPadding(new javafx.geometry.Insets(10));
        Map<CheckBox, String> checkBoxMap = new HashMap<>();
        
        for (String s : entries) {
            CheckBox cb = new CheckBox(s);
            cb.setSelected(true);
            vbox.getChildren().add(cb);
            checkBoxMap.put(cb, s);
        }
        
        dialog.getDialogPane().setContent(new ScrollPane(vbox));
        dialog.getDialogPane().getButtonTypes().addAll(ButtonType.OK, ButtonType.CANCEL);
        
        dialog.setResultConverter(btn -> {
            if (btn == ButtonType.OK) {
                List<String> selected = new ArrayList<>();
                for (Map.Entry<CheckBox, String> entry : checkBoxMap.entrySet()) {
                    if (entry.getKey().isSelected()) selected.add(entry.getValue());
                }
                return selected;
            }
            return null;
        });
        
        return dialog.showAndWait().orElse(null);
    }

    private CoordinateReferenceSystem showCRSSelectionDialog(String layerName) {
        Dialog<CoordinateReferenceSystem> dialog = new Dialog<>();
        dialog.setTitle("Unknown Coordinate System");
        dialog.setHeaderText("The layer '" + layerName + "' has no projection info.\nPlease select the correct CRS:");
        
        VBox vbox = new VBox(10);
        vbox.setPadding(new javafx.geometry.Insets(10));
        
        ComboBox<String> crsCombo = new ComboBox<>();
        crsCombo.getItems().addAll("WGS 84 (EPSG:4326)", "Web Mercator (EPSG:3857)", "UTM (Automatic - best guess)");
        crsCombo.getSelectionModel().selectFirst();
        vbox.getChildren().add(crsCombo);
        
        dialog.getDialogPane().setContent(vbox);
        dialog.getDialogPane().getButtonTypes().addAll(ButtonType.OK, ButtonType.CANCEL);
        
        dialog.setResultConverter(btn -> {
            if (btn == ButtonType.OK) {
                try {
                    String sel = crsCombo.getValue();
                    if (sel.contains("4326")) return DefaultGeographicCRS.WGS84;
                    if (sel.contains("3857")) return CRS.decode("EPSG:3857");
                    return masterCRS; // Fallback to master
                } catch (Exception e) { return DefaultGeographicCRS.WGS84; }
            }
            return null;
        });
        
        return dialog.showAndWait().orElse(null);
    }

    private void showError(String title, String message) {
        Alert alert = new Alert(Alert.AlertType.ERROR);
        alert.setTitle(title);
        alert.setHeaderText(null);
        alert.setContentText(message);
        alert.showAndWait();
    }

    private void processVectorLayer(VectorService.VectorData data, String filename) throws Exception {
        for (String existing : layerList.getItems()) if (existing.contains(filename)) return;
        if (vectorLayers.isEmpty() && rasterLayers.isEmpty()) {
            if (data.crs != null) masterCRS = data.crs;
        } else if (data.crs != null && !data.crs.equals(masterCRS)) {
            MathTransform transform = CRS.findMathTransform(data.crs, masterCRS, true);
            List<Geometry> reprojected = new ArrayList<>();
            for (Geometry g : data.geometries) reprojected.add(JTS.transform(g, transform));
            data.geometries = reprojected;
            data.envelope = new ReferencedEnvelope(JTS.transform(data.envelope, transform), masterCRS);
            data.rebuildIndex();
        }
        vectorNames.put(data, filename); vectorLayers.add(data);
        tileCache.clear(); layerList.getItems().add("[Vector] " + filename);
    }

    private final java.util.HashMap<GeoTiffService.RasterData, org.locationtech.jts.geom.Envelope> layerMasterEnv = new java.util.HashMap<>();
    private final java.util.HashMap<GeoTiffService.RasterData, MathTransform> masterToLayerXform = new java.util.HashMap<>();

    private void processRasterLayer(GeoTiffService.RasterData data) throws Exception {
        for (GeoTiffService.RasterData existing : rasterLayers) if (existing.name.equals(data.name)) return;
        CoordinateReferenceSystem crs = data.envelope.getCoordinateReferenceSystem();
        
        if (masterCRS == null && crs != null) {
            masterCRS = crs;
            viewport = new ReferencedEnvelope(data.envelope);
            System.err.println("DEBUG: Master CRS set to " + (masterCRS == null ? "NULL" : masterCRS.getName().getCode()));
        } else if (crs != null && !crs.equals(masterCRS)) {
            try {
                // Use ReferencedEnvelope transform which is much smarter about Axis Order
                ReferencedEnvelope transformed = data.envelope.transform(masterCRS, true);
                layerMasterEnv.put(data, transformed);
                masterToLayerXform.put(data, CRS.findMathTransform(masterCRS, crs, true));
                rasterLayers.add(data); tileCache.clear();
                layerList.getItems().add("[Raster] " + data.name);
                return;
            } catch (Exception e) {
                System.err.println("ERROR: Failed to reproject raster layer " + data.name + ": " + e.getMessage());
            }
        }
        layerMasterEnv.put(data, data.envelope);
        rasterLayers.add(data); tileCache.clear();
        layerList.getItems().add("[Raster] " + data.name);
    }

    private void setupInteractivity() {
        mapCanvas.setOnMousePressed(e -> { panAnchor[0] = e.getX(); panAnchor[1] = e.getY(); });
        mapCanvas.setOnMouseDragged(e -> {
            double dx = e.getX() - panAnchor[0], dy = e.getY() - panAnchor[1];
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
            
            isDragging = true;
            double wdx = dx * (viewport.getWidth() / mapCanvas.getWidth());
            double wdy = dy * (viewport.getHeight() / mapCanvas.getHeight());
            viewport = new ReferencedEnvelope(viewport.getMinX() - wdx, viewport.getMaxX() - wdx, viewport.getMinY() + wdy, viewport.getMaxY() + wdy, masterCRS);
            panAnchor[0] = e.getX(); panAnchor[1] = e.getY();
            
            hqTimer.stop(); hqTimer.play();
            drawMap(true);
        });
        mapCanvas.setOnMouseMoved(e -> {
        });
        mapCanvas.setOnScroll(e -> {
            double f = (e.getDeltaY() > 0) ? 0.8 : 1.25;
            double nw = viewport.getWidth() * f, nh = viewport.getHeight() * f;
            double cx = viewport.getMedian(0), cy = viewport.getMedian(1);
            viewport = new ReferencedEnvelope(cx - nw/2, cx + nw/2, cy - nh/2, cy + nh/2, masterCRS);
            hqTimer.stop(); hqTimer.play();
            drawMap(true);
        });
        btnZoomIn.setOnAction(e -> {
            double cx = viewport.getMedian(0), cy = viewport.getMedian(1);
            double nw = viewport.getWidth() * 0.8, nh = viewport.getHeight() * 0.8;
            viewport = new ReferencedEnvelope(cx - nw/2, cx + nw/2, cy - nh/2, cy + nh/2, masterCRS);
            hqTimer.stop(); hqTimer.play();
            drawMap(true);
        });
        btnZoomOut.setOnAction(e -> {
            double cx = viewport.getMedian(0), cy = viewport.getMedian(1);
            double nw = viewport.getWidth() * 1.25, nh = viewport.getHeight() * 1.25;
            viewport = new ReferencedEnvelope(cx - nw/2, cx + nw/2, cy - nh/2, cy + nh/2, masterCRS);
            hqTimer.stop(); hqTimer.play();
            drawMap(true);
        });
    }

    // setupViewToggleButtons removed as buttons are now in FXML

    private void switchTo2D() {
        if (!is3DMode) return;
        is3DMode = false;
        mapCanvas.setOpacity(1);
        if (scene3D != null) {
            scene3D.setVisible(false);
            scene3D.setManaged(false);
        }
        if (exaggerationSlider3D != null) {
            exaggerationSlider3D.setVisible(false);
            exaggerationSlider3D.setManaged(false);
        }
        if (txtExaggeration3D != null) {
            txtExaggeration3D.setVisible(false);
            txtExaggeration3D.setManaged(false);
        }
        if (resolutionSpinner3D != null) {
            resolutionSpinner3D.setVisible(false);
            resolutionSpinner3D.setManaged(false);
        }
        if (btnExportOBJ != null) {
            btnExportOBJ.setVisible(false);
            btnExportOBJ.setManaged(false);
        }
        if (btnTiffToOBJ != null) {
            btnTiffToOBJ.setVisible(false);
            btnTiffToOBJ.setManaged(false);
        }
        if (btnImportOBJ != null) {
            btnImportOBJ.setVisible(false);
            btnImportOBJ.setManaged(false);
        }
        drawMap(false);
    }

    private void switchTo3D() {
        if (is3DMode) return;
        is3DMode = true;
        mapCanvas.setOpacity(0);
        if (exaggerationSlider3D != null) {
            exaggerationSlider3D.setVisible(true);
            exaggerationSlider3D.setManaged(true);
        }
        if (txtExaggeration3D != null) {
            txtExaggeration3D.setVisible(true);
            txtExaggeration3D.setManaged(true);
        }
        if (resolutionSpinner3D != null) {
            resolutionSpinner3D.setVisible(true);
            resolutionSpinner3D.setManaged(true);
        }
        if (btnExportOBJ != null) {
            btnExportOBJ.setVisible(true);
            btnExportOBJ.setManaged(true);
        }
        if (btnTiffToOBJ != null) {
            btnTiffToOBJ.setVisible(true);
            btnTiffToOBJ.setManaged(true);
        }
        if (btnImportOBJ != null) {
            btnImportOBJ.setVisible(true);
            btnImportOBJ.setManaged(true);
        }
        setup3DScene();
    }

    private void setup3DScene() {
        if (scene3D != null) {
            build3DContent();
            scene3D.setVisible(true);
            scene3D.setManaged(true);
            scene3D.toFront();
            mapCanvas.setOpacity(0);
            return;
        }

        world3D = new Group();

        camera3D = new PerspectiveCamera(true);
        camera3D.setNearClip(0.01);
        camera3D.setFarClip(5000);

        rotateX = new Rotate(-35, Rotate.X_AXIS);
        rotateY = new Rotate(-30, Rotate.Y_AXIS);
        translateCam = new Translate(0, 0, 0);

        // Camera at translateCam position, looking in rotateX*rotateY direction
        camera3D.getTransforms().addAll(rotateX, rotateY, translateCam);

        AmbientLight ambient = new AmbientLight(Color.rgb(140, 150, 170));
        PointLight sunLight = new PointLight(Color.rgb(255, 220, 180));
        sunLight.getTransforms().addAll(new Translate(15, -30, -20));
        PointLight fillLight = new PointLight(Color.rgb(100, 130, 180));
        fillLight.getTransforms().addAll(new Translate(-15, -20, 15));

        build3DContent();

        Group root3D = new Group(world3D, ambient, sunLight, fillLight, camera3D);

        scene3D = new SubScene(root3D, 10, 10, true, SceneAntialiasing.BALANCED);
        scene3D.setCamera(camera3D);
        scene3D.setFill(Color.rgb(12, 16, 28));
        scene3D.widthProperty().bind(mapContainer.widthProperty());
        scene3D.heightProperty().bind(mapContainer.heightProperty());

        setup3DMouseControls(scene3D);

        mapContainer.getChildren().add(1, scene3D);
        StackPane.setAlignment(scene3D, javafx.geometry.Pos.CENTER);

        javafx.application.Platform.runLater(() -> {
            scene3D.toFront();
            resetCameraPosition();
        });
    }

    private void build3DContent() {
        world3D.getChildren().clear();

        for (GeoTiffService.RasterData rd : rasterLayers) {
            if (hiddenLayers.contains("[Raster] " + rd.name)) continue;
            ElevationMeshService.MeshResult result = elevationMeshService.createMesh(rd, verticalExaggeration, meshResolution);
            if (result != null) {
                world3D.getChildren().add(result.meshView);
            }
        }

        for (VectorService.VectorData v : vectorLayers) {
            String vName = vectorNames.get(v);
            if (vName != null && hiddenLayers.contains("[Vector] " + vName)) continue;
            for (org.locationtech.jts.geom.Geometry g : v.geometries) {
                MeshView lineMesh = createVectorMesh3D(g, v.color);
                if (lineMesh != null) world3D.getChildren().add(lineMesh);
            }
        }

        for (ImportedModel model : importedModels) {
            if (!model.visible) continue;
            if (hiddenLayers.contains("[3D] " + model.name)) continue;
            world3D.getChildren().addAll(model.meshViews);
        }
        
        // Removed addGroundGrid() as it causes visual confusion with real terrain scales
    }

    private MeshView createVectorMesh3D(org.locationtech.jts.geom.Geometry geom, Color color) {
        java.util.List<double[]> points = new java.util.ArrayList<>();
        if (geom instanceof org.locationtech.jts.geom.LineString) {
            org.locationtech.jts.geom.Coordinate[] coords = geom.getCoordinates();
            for (org.locationtech.jts.geom.Coordinate c : coords) points.add(new double[]{c.x, c.y});
        } else if (geom instanceof org.locationtech.jts.geom.MultiLineString) {
            for (int i = 0; i < geom.getNumGeometries(); i++) {
                for (org.locationtech.jts.geom.Coordinate c : geom.getGeometryN(i).getCoordinates()) {
                    points.add(new double[]{c.x, c.y});
                }
            }
        } else if (geom instanceof org.locationtech.jts.geom.Polygon) {
            for (org.locationtech.jts.geom.Coordinate c : ((org.locationtech.jts.geom.Polygon) geom).getExteriorRing().getCoordinates()) {
                points.add(new double[]{c.x, c.y});
            }
        } else if (geom instanceof org.locationtech.jts.geom.MultiPolygon) {
            for (int i = 0; i < geom.getNumGeometries(); i++) {
                for (org.locationtech.jts.geom.Coordinate c : geom.getGeometryN(i).getCoordinates()) {
                    points.add(new double[]{c.x, c.y});
                }
            }
        }
        if (points.size() < 2) return null;

        float scale = 10.0f;
        double minLon = viewport.getMinX(), maxLon = viewport.getMaxX();
        double minLat = viewport.getMinY(), maxLat = viewport.getMaxY();
        double rangeX = maxLon - minLon, rangeY = maxLat - minLat;
        if (rangeX <= 0) rangeX = 1;
        if (rangeY <= 0) rangeY = 1;

        TriangleMesh mesh = new TriangleMesh();
        float tubeRadius = 0.03f;
        int segments = 4;

        for (int i = 0; i < points.size(); i++) {
            double[] p = points.get(i);
            float px = (float) ((p[0] - minLon) / rangeX * scale - scale / 2.0);
            float pz = (float) ((p[1] - minLat) / rangeY * scale - scale / 2.0);
            float py = 0.05f;
            for (int s = 0; s <= segments; s++) {
                double angle = 2 * Math.PI * s / segments;
                float ox = (float) (Math.cos(angle) * tubeRadius);
                float oy = (float) (Math.sin(angle) * tubeRadius);
                mesh.getPoints().addAll(px + ox, py + oy, pz);
            }
        }

        int vertsPerPoint = segments + 1;
        for (int i = 0; i < points.size(); i++) {
            float t = i / (float) Math.max(1, points.size() - 1);
            for (int s = 0; s <= segments; s++) {
                mesh.getTexCoords().addAll(t, s / (float) segments);
            }
        }

        for (int i = 0; i < points.size() - 1; i++) {
            for (int s = 0; s < segments; s++) {
                int base = i * vertsPerPoint + s;
                int next = base + vertsPerPoint;
                mesh.getFaces().addAll(base, base, base + 1, base + 1, next, next);
                mesh.getFaces().addAll(base + 1, base + 1, next, next, next + 1, next + 1);
            }
        }

        MeshView mv = new MeshView(mesh);
        mv.setCullFace(CullFace.NONE);
        mv.setDrawMode(DrawMode.FILL);
        PhongMaterial mat = new PhongMaterial(color);
        mat.setSpecularColor(Color.rgb(50, 50, 50));
        mat.setSpecularPower(8.0);
        mv.setMaterial(mat);
        return mv;
    }

    private void resetCameraPosition() {
        if (world3D == null || camera3D == null) return;
        
        world3D.layout(); 
        javafx.geometry.Bounds bounds = world3D.getBoundsInLocal();
        
        if (bounds == null || bounds.isEmpty() || bounds.getWidth() == 0) {
            translateCam.setX(0);
            translateCam.setY(-5);
            translateCam.setZ(-25);
            rotateX.setAngle(-15);
            rotateY.setAngle(-30);
            return;
        }

        double centerX = (bounds.getMinX() + bounds.getMaxX()) / 2.0;
        double centerY = (bounds.getMinY() + bounds.getMaxY()) / 2.0;
        double centerZ = (bounds.getMinZ() + bounds.getMaxZ()) / 2.0;

        double maxDim = Math.max(bounds.getWidth(), Math.max(bounds.getHeight(), bounds.getDepth()));
        double fovRad = Math.toRadians(30);
        double distance = -(maxDim / (2.0 * Math.tan(fovRad / 2.0)));

        translateCam.setX(-centerX);
        translateCam.setY(centerY - maxDim * 0.5);
        translateCam.setZ(-centerZ + distance);
        
        rotateX.setAngle(-15);
        rotateY.setAngle(-30);
    }

    private void setup3DMouseControls(SubScene scene) {
        scene.setOnMousePressed(e -> {
            mouseOldX = e.getSceneX();
            mouseOldY = e.getSceneY();
        });

        scene.setOnMouseDragged(e -> {
            double dx = e.getSceneX() - mouseOldX;
            double dy = e.getSceneY() - mouseOldY;
            mouseOldX = e.getSceneX();
            mouseOldY = e.getSceneY();

            if (e.isPrimaryButtonDown()) {
                rotateY.setAngle(rotateY.getAngle() + dx * 0.4);
                double newAngleX = rotateX.getAngle() - dy * 0.4;
                rotateX.setAngle(Math.max(-89, Math.min(10, newAngleX)));
            } else if (e.isSecondaryButtonDown() || e.isMiddleButtonDown()) {
                translateCam.setX(translateCam.getX() + dx * 0.03);
                translateCam.setY(translateCam.getY() + dy * 0.03);
            }
        });

        scene.setOnScroll(e -> {
            double delta = e.getDeltaY();
            double z = translateCam.getZ();
            double factor = Math.exp(-delta * 0.002);
            translateCam.setZ(Math.max(-100000, Math.min(-0.5, z * factor)));
        });
    }

    private void setupFloatingToolbar() {
        VBox toolbar = new VBox(12);
        toolbar.getStyleClass().add("floating-toolbar");
        toolbar.setAlignment(javafx.geometry.Pos.CENTER);
        toolbar.setPickOnBounds(true);

        // 1. Navigation Button (Black square in Image 2)
        ToggleButton btnNav = new ToggleButton();
        btnNav.getStyleClass().addAll("floating-tool-button", "tool-nav-active");
        btnNav.setGraphic(new FontIcon("fas-location-arrow"));
        
        // 2. Group / Connection Button (White square with red dot in Image 2)
        btnDrawGroup = new ToggleButton();
        btnDrawGroup.getStyleClass().addAll("floating-tool-button", "tool-notification");
        
        StackPane groupIconStack = new StackPane();
        FontIcon groupIcon = new FontIcon("fas-project-diagram");
        javafx.scene.shape.Circle dot = new javafx.scene.shape.Circle(4, javafx.scene.paint.Color.web("#ff3b30"));
        dot.getStyleClass().add("notification-dot");
        StackPane.setAlignment(dot, javafx.geometry.Pos.TOP_LEFT);
        dot.setTranslateX(-2);
        dot.setTranslateY(-2);
        groupIconStack.getChildren().addAll(groupIcon, dot);
        btnDrawGroup.setGraphic(groupIconStack);

        // 3. Polygon Button (Pentagon in Image 2)
        btnDrawPolygon = new ToggleButton();
        btnDrawPolygon.getStyleClass().add("floating-tool-button");
        btnDrawPolygon.setGraphic(new FontIcon("fas-draw-polygon"));

        // 4. Line Button (Pencil in Image 2)
        btnDrawLine = new ToggleButton();
        btnDrawLine.getStyleClass().add("floating-tool-button");
        btnDrawLine.setGraphic(new FontIcon("fas-pencil-alt"));

        // Separator
        javafx.scene.shape.Line separatorLine = new javafx.scene.shape.Line(0, 0, 30, 0);
        separatorLine.setStroke(javafx.scene.paint.Color.rgb(0, 0, 0, 0.1));
        separatorLine.setStrokeWidth(2);

        // 5. Magnet Button (with label)
        ToggleButton btnMagnet = new ToggleButton();
        btnMagnet.getStyleClass().addAll("floating-tool-button", "magnet-button");
        btnMagnet.setGraphic(new FontIcon("fas-magnet"));
        
        Label magnetLabel = new Label("MAGNET");
        magnetLabel.getStyleClass().add("magnet-label");
        
        StackPane magnetBox = new StackPane(btnMagnet, magnetLabel);
        magnetBox.setAlignment(javafx.geometry.Pos.CENTER);
        magnetBox.setMaxWidth(44); // Keep width same as other buttons for alignment
        magnetLabel.setTranslateX(65); // Offset label to the right
        magnetLabel.setMouseTransparent(true); // Don't block clicks
        magnetLabel.setManaged(false); // Don't affect parent width

        // 6. Ruler / Measurement
        Button btnRuler = new Button();
        btnRuler.getStyleClass().add("floating-tool-button");
        btnRuler.setGraphic(new FontIcon("fas-ruler-combined"));

        // Contextual Finish/Cancel buttons
        btnFinishDrawing = new Button();
        btnFinishDrawing.getStyleClass().addAll("floating-tool-button", "tool-nav-active");
        btnFinishDrawing.setGraphic(new FontIcon("fas-check"));
        btnFinishDrawing.setVisible(false);
        btnFinishDrawing.setManaged(false);

        btnCancelDrawing = new Button();
        btnCancelDrawing.getStyleClass().add("floating-tool-button");
        btnCancelDrawing.setGraphic(new FontIcon("fas-times"));
        btnCancelDrawing.setVisible(false);
        btnCancelDrawing.setManaged(false);

        // Toggle Group for drawing modes
        ToggleGroup tg = new ToggleGroup();
        btnNav.setToggleGroup(tg);
        btnDrawGroup.setToggleGroup(tg);
        btnDrawPolygon.setToggleGroup(tg);
        btnDrawLine.setToggleGroup(tg);
        btnNav.setSelected(true);

        toolbar.getChildren().addAll(btnNav, btnDrawGroup, btnDrawPolygon, btnDrawLine, separatorLine, magnetBox, btnRuler, btnFinishDrawing, btnCancelDrawing);

        toolbar.setMaxWidth(68);
        toolbar.setPrefWidth(68);

        // Add to mapContainer as a floating overlay - MOVED TO THE LEFT
        StackPane.setAlignment(toolbar, javafx.geometry.Pos.CENTER_LEFT);
        StackPane.setMargin(toolbar, new javafx.geometry.Insets(0, 0, 0, 20));
        mapContainer.getChildren().add(toolbar);

        // Wiring actions
        btnDrawLine.setOnAction(e -> setDrawingMode(DrawingService.Mode.LINE));
        btnDrawPolygon.setOnAction(e -> setDrawingMode(DrawingService.Mode.POLYGON));
        btnDrawGroup.setOnAction(e -> setDrawingMode(DrawingService.Mode.GROUP));
        btnNav.setOnAction(e -> setDrawingMode(DrawingService.Mode.NONE));
        btnFinishDrawing.setOnAction(e -> finishGroup());
        btnCancelDrawing.setOnAction(e -> cancelDrawing());

        tg.selectedToggleProperty().addListener((obs, old, sel) -> {
            boolean active = (sel != null && sel != btnNav);
            btnFinishDrawing.setVisible(active);
            btnFinishDrawing.setManaged(active);
            btnCancelDrawing.setVisible(active);
            btnCancelDrawing.setManaged(active);
        });
    }

    private void setupDrawingHandlers() {
        mapCanvas.setOnMousePressed(e -> {
            panAnchor[0] = e.getX(); panAnchor[1] = e.getY();
            if (drawingService.isActive() && e.getButton() == MouseButton.PRIMARY) {
                double wx = screenToWorldX(e.getX());
                double wy = screenToWorldY(e.getY());
                drawingService.addPoint(wx, wy);
                drawMap(false);
            }
        });
        mapCanvas.setOnMouseMoved(e -> {
            if (drawingService.isActive()) {
                cursorWorldX = screenToWorldX(e.getX());
                cursorWorldY = screenToWorldY(e.getY());
                drawMap(true);
            } else {
                lblCoords.setText(String.format("%.4f, %.4f", screenToWorldX(e.getX()), screenToWorldY(e.getY())));
            }
        });
        mapCanvas.setOnMouseClicked(e -> {
            if (!drawingService.isActive()) return;
            if (e.getButton() == MouseButton.SECONDARY) {
                finishShape();
            }
        });
        mapCanvas.addEventFilter(MouseEvent.MOUSE_DRAGGED, e -> {
            if (drawingService.isActive()) e.consume();
        });
    }

    private void setDrawingMode(DrawingService.Mode mode) {
        drawingService.setMode(mode);
        if (mode != DrawingService.Mode.NONE) {
            btnFinishDrawing.setDisable(true);
            btnCancelDrawing.setDisable(false);
        }
        drawMap(false);
    }

    private void finishShape() {
        if (!drawingService.isActive()) return;
        Geometry geom = drawingService.finishShape();
        if (geom != null) {
            addDrawnLayer(geom);
            deactivateDrawingMode();
        } else if (drawingService.getCurrentMode() == DrawingService.Mode.GROUP) {
            btnFinishDrawing.setDisable(false);
            drawMap(false);
        }
    }

    private void finishGroup() {
        if (drawingService.getCurrentMode() != DrawingService.Mode.GROUP) return;
        Geometry geom = drawingService.finishGroup();
        if (geom != null) {
            addDrawnLayer(geom);
        }
        deactivateDrawingMode();
    }

    private void cancelDrawing() {
        drawingService.cancel();
        deactivateDrawingMode();
        drawMap(false);
    }

    private void deactivateDrawingMode() {
        drawingService.setMode(DrawingService.Mode.NONE);
        ToggleGroup tg = btnDrawLine.getToggleGroup();
        if (tg != null) tg.selectToggle(null);
        btnFinishDrawing.setDisable(true);
        btnCancelDrawing.setDisable(true);
    }

    private void addDrawnLayer(Geometry geom) {
        org.locationtech.jts.geom.Envelope env = geom.getEnvelopeInternal();
        ReferencedEnvelope refEnv = new ReferencedEnvelope(env, masterCRS);
        List<Geometry> geoms = new ArrayList<>();
        geoms.add(geom);
        VectorService.VectorData data = new VectorService.VectorData(geoms, new ArrayList<>(), refEnv, masterCRS);
        drawingCounter++;
        String name = "Drawing " + drawingCounter;
        vectorNames.put(data, name);
        vectorLayers.add(data);
        tileCache.clear();
        layerList.getItems().add("[Vector] " + name);
        zoomToLayer("[Vector] " + name);
    }

    private void drawDrawingPreview(GraphicsContext gc) {
        if (!drawingService.isActive() || drawingService.getCurrentPoints().isEmpty()) return;

        java.util.List<Coordinate> pts = drawingService.getCurrentPoints();

        gc.setStroke(Color.CYAN);
        gc.setLineWidth(2.5);
        gc.setLineDashes(8, 6);

        if (drawingService.getCurrentMode() == DrawingService.Mode.POLYGON && pts.size() >= 2) {
            double[] xp = new double[pts.size() + 1];
            double[] yp = new double[pts.size() + 1];
            for (int i = 0; i < pts.size(); i++) {
                xp[i] = worldToScreenX(pts.get(i).x, viewport);
                yp[i] = worldToScreenY(pts.get(i).y, viewport);
            }
            xp[pts.size()] = worldToScreenX(cursorWorldX, viewport);
            yp[pts.size()] = worldToScreenY(cursorWorldY, viewport);
            gc.setFill(Color.CYAN.deriveColor(0, 1, 1, 0.3));
            gc.fillPolygon(xp, yp, pts.size() + 1);
        }

        gc.beginPath();
        gc.moveTo(worldToScreenX(pts.get(0).x, viewport), worldToScreenY(pts.get(0).y, viewport));
        for (int i = 1; i < pts.size(); i++) {
            gc.lineTo(worldToScreenX(pts.get(i).x, viewport), worldToScreenY(pts.get(i).y, viewport));
        }
        gc.lineTo(worldToScreenX(cursorWorldX, viewport), worldToScreenY(cursorWorldY, viewport));
        gc.stroke();
        gc.setLineDashes(null);

        if (drawingService.getCurrentMode() == DrawingService.Mode.POLYGON ||
            drawingService.getCurrentMode() == DrawingService.Mode.GROUP) {
            if (pts.size() >= 2) {
                gc.setStroke(Color.CYAN);
                gc.setLineWidth(1);
                gc.setLineDashes(6, 10);
                gc.strokeLine(
                    worldToScreenX(cursorWorldX, viewport), worldToScreenY(cursorWorldY, viewport),
                    worldToScreenX(pts.get(0).x, viewport), worldToScreenY(pts.get(0).y, viewport)
                );
                gc.setLineDashes(null);
            }
        }

        for (Coordinate p : pts) {
            double sx = worldToScreenX(p.x, viewport);
            double sy = worldToScreenY(p.y, viewport);
            gc.setFill(Color.CYAN);
            gc.fillOval(sx - 4, sy - 4, 8, 8);
        }

        if (drawingService.getCurrentMode() == DrawingService.Mode.GROUP) {
            gc.setStroke(Color.LIME);
            gc.setLineWidth(2);
            for (Geometry g : drawingService.getCompletedGeometries()) {
                renderGeometry(gc, g, viewport);
            }
        }
    }

    private void drawMap(boolean fast) {
        GraphicsContext gc = mapCanvas.getGraphicsContext2D();
        double w = mapCanvas.getWidth(), h = mapCanvas.getHeight();
        if (w <= 0 || h <= 0) return;

        // OPTIMIZATION: Rubber-banding (Pixelation during movement)
        if (fast && canvasCache != null && cacheViewport != null) {
            gc.setFill(Color.web("#121212"));
            gc.fillRect(0, 0, w, h);

            double viewW = viewport.getWidth(), viewH = viewport.getHeight();
            double oldW = cacheViewport.getWidth(), oldH = cacheViewport.getHeight();
            
            double scaleX = oldW / viewW;
            double scaleY = oldH / viewH;
            
            double offsetX = (cacheViewport.getMinX() - viewport.getMinX()) / viewW * w;
            double offsetY = (viewport.getMaxY() - cacheViewport.getMaxY()) / viewH * h;

            gc.drawImage(canvasCache, offsetX, offsetY, w * scaleX, h * scaleY);
            
            // Only draw dynamic elements (drawing tools) during drag
            drawDrawingPreview(gc);
            
            return;
        }

        // Full Render Path (Double-buffered to prevent flicker)
        if (offscreenBuffer == null || offscreenBuffer.getWidth() != w || offscreenBuffer.getHeight() != h) {
            offscreenBuffer = new Canvas(w, h);
        }
        GraphicsContext ogc = offscreenBuffer.getGraphicsContext2D();
        
        ogc.setFill(Color.web("#121212")); 
        ogc.fillRect(0, 0, w, h);
        
        if (showBaseMap) {
            int maxSize = fast ? 256 : 1024;
            int bmW = Math.max(1, Math.min((int) Math.ceil(w), maxSize)), bmH = Math.max(1, Math.min((int) Math.ceil(h), maxSize));
            org.locationtech.jts.geom.Envelope bmViewport = viewport;
            if (masterCRS != null && !masterCRS.equals(DefaultGeographicCRS.WGS84)) {
                try {
                    MathTransform toWgs = CRS.findMathTransform(masterCRS, DefaultGeographicCRS.WGS84, true);
                    bmViewport = JTS.transform(viewport, toWgs);
                } catch (Exception e) {}
            }
            javafx.scene.image.Image bmImg = baseMapService.renderReprojected(bmViewport, bmW, bmH);
            if (bmImg != null) ogc.drawImage(bmImg, 0, 0, w, h);
        }

        for (GeoTiffService.RasterData rd : rasterLayers) {
            if (hiddenLayers.contains("[Raster] " + rd.name)) continue;
            renderRasterLayer(ogc, rd, fast, w, h);
        }

        drawVectors(ogc);
        drawDrawingPreview(ogc);

        if (!labelConfigs.isEmpty()) {
            LabelService.LabelResult labelResult = labelService.placeLabels(
                    vectorLayers, labelConfigs, viewport, w, h,
                    (wx, wy) -> worldToScreenX(wx, viewport),
                    (wy, wx) -> worldToScreenY(wy, viewport));
            labelService.renderLabels(ogc, labelResult.placedLabels);
        }

        // Blit offscreen buffer to canvas in one operation
        javafx.scene.image.WritableImage snapshot = offscreenBuffer.snapshot(null, null);
        gc.drawImage(snapshot, 0, 0);

        // Update statistics and cache
        if (!fast) {
            double res = viewport.getWidth() / w; 
            int zoom = (int) Math.round(-Math.log(res) / Math.log(2));
            lblZoom.setText(String.format("v3.1.5-FINAL-OPT | Layers: %d | Zoom: %d | CRS: %s", 
                rasterLayers.size(), zoom, (masterCRS == null ? "None" : masterCRS.getName().getCode())));
            
            updateCache();
        }
    }

    private void updateCache() {
        try {
            double w = mapCanvas.getWidth(), h = mapCanvas.getHeight();
            if (w <= 0 || h <= 0) return;
            
            // We use snapshot to capture the result of the full render
            // This image will be used for rubber-banding during the next drag/zoom
            canvasCache = mapCanvas.snapshot(null, null);
            cacheViewport = new ReferencedEnvelope(viewport);
        } catch (Exception e) {
            System.err.println("DEBUG: Failed to update canvas cache: " + e.getMessage());
        }
    }

    private void renderRasterLayer(GraphicsContext gc, GeoTiffService.RasterData rd, boolean fast, double w, double h) {
        org.locationtech.jts.geom.Envelope masterEnv = layerMasterEnv.get(rd);
        if (masterEnv == null) masterEnv = rd.envelope;
        int maxSize = fast ? 256 : 1024;
        int renderW = Math.max(1, Math.min((int) Math.ceil(w), maxSize)), renderH = Math.max(1, Math.min((int) Math.ceil(h), maxSize));
        MathTransform toLayer = masterToLayerXform.get(rd);
        ReferencedEnvelope renderEnv;
        org.locationtech.jts.geom.Envelope clipEnv;
        if (toLayer != null) {
            try {
                // SMARTER: Transform the viewport directly to the layer's CRS
                renderEnv = viewport.transform(rd.envelope.getCoordinateReferenceSystem(), true);
                clipEnv = rd.envelope; // Use the native envelope for clipping
            } catch (Exception e) { return; }
        } else {
            renderEnv = new ReferencedEnvelope(viewport); clipEnv = masterEnv;
        }
        BufferedImage bi = tiffService.renderTile(rd, renderEnv, renderW, renderH, clipEnv);
        if (bi != null) gc.drawImage(SwingFXUtils.toFXImage(bi, null), 0, 0, w, h);
    }

    private void drawVectors(GraphicsContext gc) {
        org.locationtech.jts.geom.Envelope viewEnv = new org.locationtech.jts.geom.Envelope(viewport.getMinX(), viewport.getMaxX(), viewport.getMinY(), viewport.getMaxY());
        double minPixelSize = (viewport.getWidth() / mapCanvas.getWidth()) * 0.5; // Anything smaller than 0.5 pixels
        
        for (VectorService.VectorData v : vectorLayers) {
            String vName = vectorNames.get(v);
            if (vName != null && hiddenLayers.contains("[Vector] " + vName)) continue;
            
            gc.setStroke(v.color); 
            gc.setLineWidth(1.5);
            gc.setFill(v.fillColor);
            
            // Query spatial index for features in viewport
            List<Geometry> visible = v.spatialIndex.query(viewEnv);
            
            for (Geometry g : visible) {
                // Quick check: if geometry bounding box is smaller than minPixelSize, skip or render as point
                org.locationtech.jts.geom.Envelope ge = g.getEnvelopeInternal();
                if (ge.getWidth() < minPixelSize && ge.getHeight() < minPixelSize) {
                    // Render tiny objects as a single pixel point for performance
                    double px = worldToScreenX(ge.centre().x, viewport);
                    double py = worldToScreenY(ge.centre().y, viewport);
                    gc.fillRect(px, py, 1, 1);
                    continue;
                }
                renderGeometry(gc, g, viewport);
            }
        }
    }

    private void requestDraw() {
        if (drawPending) return;
        drawPending = true;
        Platform.runLater(() -> { drawMap(false); drawPending = false; });
    }

    private double[] xpBuffer = new double[1000];
    private double[] ypBuffer = new double[1000];

    private void renderGeometry(GraphicsContext gc, org.locationtech.jts.geom.Geometry g, ReferencedEnvelope view) {
        if (g instanceof Polygon) {
            Coordinate[] cs = ((Polygon) g).getExteriorRing().getCoordinates();
            if (cs.length > xpBuffer.length) {
                xpBuffer = new double[cs.length + 500];
                ypBuffer = new double[cs.length + 500];
            }
            
            // Aggressive screen-space vertex decimation
            int count = 0;
            double lastX = Double.NaN, lastY = Double.NaN;
            for (int i=0; i<cs.length; i++) { 
                double sx = worldToScreenX(cs[i].x, view); 
                double sy = worldToScreenY(cs[i].y, view);
                
                // If this point is effectively at the same pixel as the last one, skip it
                if (Math.abs(sx - lastX) < 1.0 && Math.abs(sy - lastY) < 1.0 && i > 0 && i < cs.length - 1) continue;
                
                xpBuffer[count] = sx; 
                ypBuffer[count] = sy;
                lastX = sx; lastY = sy;
                count++;
            }
            if (count < 2) return;
            gc.fillPolygon(xpBuffer, ypBuffer, count);
            gc.strokePolygon(xpBuffer, ypBuffer, count);
            
        } else if (g instanceof LineString) {
            Coordinate[] cs = g.getCoordinates();
            gc.beginPath(); 
            double lastX = Double.NaN, lastY = Double.NaN;
            boolean first = true;
            for (int i=0; i<cs.length; i++) {
                double sx = worldToScreenX(cs[i].x, view);
                double sy = worldToScreenY(cs[i].y, view);
                if (Math.abs(sx - lastX) < 1.0 && Math.abs(sy - lastY) < 1.0 && i > 0 && i < cs.length - 1) continue;
                if (first) { gc.moveTo(sx, sy); first = false; }
                else gc.lineTo(sx, sy);
                lastX = sx; lastY = sy;
            }
            gc.stroke();
        } else if (g instanceof MultiPolygon) {
            for (int i=0; i<((MultiPolygon)g).getNumGeometries(); i++) {
                renderGeometry(gc, ((MultiPolygon)g).getGeometryN(i), view);
            }
        } else if (g instanceof MultiLineString) {
            for (int i=0; i<((MultiLineString)g).getNumGeometries(); i++) {
                renderGeometry(gc, ((MultiLineString)g).getGeometryN(i), view);
            }
        } else if (g instanceof Point) {
            double sx = worldToScreenX(g.getCoordinate().x, view);
            double sy = worldToScreenY(g.getCoordinate().y, view);
            gc.fillOval(sx - 2, sy - 2, 4, 4);
        } else if (g instanceof MultiPoint) {
            for (int i=0; i<((MultiPoint)g).getNumGeometries(); i++) {
                renderGeometry(gc, ((MultiPoint)g).getGeometryN(i), view);
            }
        }
    }

    private void setupTerrainAnalysisHandlers() {
        if (btnSlope != null) btnSlope.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.SLOPE));
        if (btnAspect != null) btnAspect.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.ASPECT));
        if (btnHillshade != null) btnHillshade.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.HILLSHADE));
        if (btnHydrology != null) btnHydrology.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.HYDROLOGY));
        if (btnMultiHillshade != null) btnMultiHillshade.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.MULTI_HILLSHADE));
        if (btnFlowAccum != null) btnFlowAccum.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.FLOW_ACCUMULATION));
        if (btnTRI != null) btnTRI.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.TRI));
        if (btnCurvature != null) btnCurvature.setOnAction(e -> runAnalysis(RasterAnalysisService.AnalysisType.CURVATURE));
        
        if (btnContours != null) btnContours.setOnAction(e -> showAlert("Coming Soon", "The Contours tool is currently under development."));
        if (btnViewshed != null) btnViewshed.setOnAction(e -> showAlert("Coming Soon", "The Viewshed tool is currently under development."));

        if (btnBuffer != null) btnBuffer.setOnAction(e -> handleBuffer());
        if (btnClip != null) btnClip.setOnAction(e -> handleClip());
        if (btnHeatmap != null) btnHeatmap.setOnAction(e -> handleHeatmap());
        
        if (btnUnion != null) btnUnion.setOnAction(e -> handleTwoLayerOp("Union"));
        if (btnErase != null) btnErase.setOnAction(e -> handleTwoLayerOp("Erase"));
        if (btnDissolve != null) btnDissolve.setOnAction(e -> handleOneLayerOp("Dissolve"));
        if (btnSimplify != null) btnSimplify.setOnAction(e -> handleOneLayerOp("Simplify"));
        if (btnCentroids != null) btnCentroids.setOnAction(e -> handleOneLayerOp("Centroids"));
        if (btnConvexHull != null) btnConvexHull.setOnAction(e -> handleOneLayerOp("Convex Hull"));
if (btnVoronoi != null) btnVoronoi.setOnAction(e -> handleOneLayerOp("Voronoi"));
    }

    private void setupVerticalExaggerationSlider() {
        if (verticalExaggerationSlider == null) return;
        verticalExaggerationSlider.setValue(verticalExaggeration);
        updateExaggerationLabels();
        verticalExaggerationSlider.valueProperty().addListener((obs, oldVal, newVal) -> {
            verticalExaggeration = newVal.floatValue();
            updateExaggerationLabels();
            if (exaggerationSlider3D != null) exaggerationSlider3D.setValue(newVal.doubleValue());
            if (is3DMode) {
                rebuild3DContent();
            }
        });
    }

    private void setup3DExaggerationSlider() {
        if (exaggerationSlider3D == null) return;
        exaggerationSlider3D.setValue(verticalExaggeration);
        exaggerationSlider3D.valueProperty().addListener((obs, oldVal, newVal) -> {
            verticalExaggeration = newVal.floatValue();
            updateExaggerationLabels();
            verticalExaggerationSlider.setValue(newVal.doubleValue());
            if (is3DMode) {
                rebuild3DContent();
            }
        });
        if (txtExaggeration3D != null) {
            txtExaggeration3D.setText(String.format("%.1f", verticalExaggeration));
            txtExaggeration3D.setOnAction(e -> {
                try {
                    float val = Float.parseFloat(txtExaggeration3D.getText());
                    val = Math.max(0.1f, Math.min(5.0f, val));
                    verticalExaggeration = val;
                    exaggerationSlider3D.setValue(val);
                    verticalExaggerationSlider.setValue(val);
                    updateExaggerationLabels();
                    if (is3DMode) rebuild3DContent();
                } catch (NumberFormatException ex) {
                    txtExaggeration3D.setText(String.format("%.1f", verticalExaggeration));
                }
            });
        }
    }

    private void updateExaggerationLabels() {
        String txt = String.format("%.1f", verticalExaggeration);
        if (lblVerticalExaggeration != null) lblVerticalExaggeration.setText(txt + "x");
        if (txtExaggeration3D != null) txtExaggeration3D.setText(txt);
    }

    private void setupResolutionSpinner() {
        if (resolutionSpinner3D == null) return;
        resolutionSpinner3D.setValueFactory(new SpinnerValueFactory.IntegerSpinnerValueFactory(80, 2000, meshResolution, 40));
        resolutionSpinner3D.setTooltip(new Tooltip("Mesh resolution (" + meshResolution + " = " + (meshResolution*meshResolution) + " vertices)"));
        resolutionSpinner3D.valueProperty().addListener((obs, oldVal, newVal) -> {
            if (newVal == null) return;
            meshResolution = newVal;
            if (is3DMode) {
                rebuild3DContent();
            }
        });
    }

    private void setupExportOBJ() {
        if (btnExportOBJ == null) return;
        btnExportOBJ.setTooltip(new Tooltip("Export 3D model as OBJ"));
        btnExportOBJ.setOnAction(e -> exportOBJ());
    }

    private void exportOBJ() {
        if (world3D == null || world3D.getChildren().isEmpty()) return;
        FileChooser fc = new FileChooser();
        fc.setTitle("Export 3D Model as OBJ");
        fc.getExtensionFilters().add(new FileChooser.ExtensionFilter("OBJ File", "*.obj"));
        fc.setInitialFileName("aeromap_3d.obj");
        File file = fc.showSaveDialog(btnExportOBJ.getScene().getWindow());
        if (file == null) return;

        int terrainCount = 0;
        System.err.println("DEBUG OBJ: Starting export...");

        String baseName = file.getName();
        if (baseName.toLowerCase().endsWith(".obj")) baseName = baseName.substring(0, baseName.length() - 4);
        File parentDir = file.getParentFile();
        File mtlFile = new File(parentDir, baseName + ".mtl");
        File pngFile = new File(parentDir, baseName + ".png");

        try (java.io.PrintWriter pw = new java.io.PrintWriter(file, "UTF-8");
             java.io.PrintWriter mw = new java.io.PrintWriter(mtlFile, "UTF-8")) {

            pw.println("# AeroMapGIS 3D Export");
            pw.println("mtllib " + mtlFile.getName());
            pw.println();

            // Extract texture from first mesh with a diffuse map
            javafx.scene.image.Image diffuseImg = null;
            javafx.scene.image.PixelReader pixelReader = null;
            for (javafx.scene.Node node : world3D.getChildren()) {
                if (!(node instanceof MeshView)) continue;
                MeshView mv = (MeshView) node;
                if (mv.getMaterial() instanceof PhongMaterial) {
                    javafx.scene.image.Image img = ((PhongMaterial) mv.getMaterial()).getDiffuseMap();
                    if (img != null) { diffuseImg = img; pixelReader = img.getPixelReader(); break; }
                }
            }

            // Save texture PNG
            boolean hasTexture = diffuseImg != null && pixelReader != null;
            if (hasTexture) {
                int tw = (int) diffuseImg.getWidth();
                int th = (int) diffuseImg.getHeight();
                java.awt.image.BufferedImage bi = new java.awt.image.BufferedImage(tw, th, java.awt.image.BufferedImage.TYPE_INT_ARGB);
                for (int y = 0; y < th; y++)
                    for (int x = 0; x < tw; x++)
                        bi.setRGB(x, y, pixelReader.getArgb(x, y));
                javax.imageio.ImageIO.write(bi, "png", pngFile);
                System.err.println("DEBUG OBJ: Texture saved: " + tw + "x" + th);
            }

            // Write MTL
            mw.println("# AeroMapGIS Material");
            mw.println("newmtl terrainMat");
            mw.println("Ka 0.8 0.8 0.8");
            mw.println("Kd 1.0 1.0 1.0");
            mw.println("Ks 0.1 0.1 0.1");
            mw.println("Ns 8.0");
            if (hasTexture) mw.println("map_Kd " + pngFile.getName());

            int vertexOffset = 1;
            int tcOffset = 1;
            for (javafx.scene.Node node : world3D.getChildren()) {
                if (!(node instanceof MeshView)) continue;
                MeshView mv = (MeshView) node;
                if (!(mv.getMesh() instanceof TriangleMesh)) continue;
                TriangleMesh mesh = (TriangleMesh) mv.getMesh();

                int ptSize = mesh.getPoints().size();
                int fcSize = mesh.getFaces().size();
                int tcSize = mesh.getTexCoords().size();
                int numVerts = ptSize / 3;
                int numTCs = tcSize / 2;
                int numFaces = fcSize / 6;

                System.err.println("DEBUG OBJ: pts=" + ptSize + " tcs=" + tcSize + " faces=" + fcSize + " verts=" + numVerts + " tris=" + numFaces);

                if (numVerts < 3 || numFaces < 1) continue;

                pw.println("o terrain_" + terrainCount);
                pw.println("g terrain_" + terrainCount);
                if (hasTexture) pw.println("usemtl terrainMat");

                float minZ = Float.MAX_VALUE, maxZ = -Float.MAX_VALUE;
                float[] zValues = new float[numVerts];
                for (int vi = 0; vi < numVerts; vi++) {
                    float vy = mesh.getPoints().get(vi * 3 + 1);
                    float bz = -vy;
                    zValues[vi] = bz;
                    if (bz < minZ) minZ = bz;
                    if (bz > maxZ) maxZ = bz;
                }

                float zRange = maxZ - minZ;
                float xyRange = 15f;
                float targetZRange = xyRange * 0.2f;
                float zScale = 1f;
                if (zRange > 0.0001f && zRange < targetZRange) zScale = targetZRange / zRange;
                System.err.println("DEBUG OBJ: Z range=" + zRange + " scaling by " + zScale);

                for (int vi = 0; vi < numVerts; vi++) {
                    float vx = mesh.getPoints().get(vi * 3);
                    float vz = mesh.getPoints().get(vi * 3 + 2);
                    pw.printf(java.util.Locale.US, "v %.6f %.6f %.6f%n", vx, vz, zValues[vi] * zScale);
                }

                for (int ti = 0; ti < numTCs; ti++) {
                    float u = mesh.getTexCoords().get(ti * 2);
                    float v = 1f - mesh.getTexCoords().get(ti * 2 + 1);
                    pw.printf(java.util.Locale.US, "vt %.6f %.6f%n", u, v);
                }

                int invalidFaces = 0;
                for (int fi = 0; fi < numFaces; fi++) {
                    int base = fi * 6;
                    int p0 = mesh.getFaces().get(base);
                    int t0 = mesh.getFaces().get(base + 1);
                    int p1 = mesh.getFaces().get(base + 2);
                    int t1 = mesh.getFaces().get(base + 3);
                    int p2 = mesh.getFaces().get(base + 4);
                    int t2 = mesh.getFaces().get(base + 5);
                    if (p0 >= numVerts || p1 >= numVerts || p2 >= numVerts ||
                        t0 >= numTCs || t1 >= numTCs || t2 >= numTCs) {
                        invalidFaces++;
                        continue;
                    }
                    pw.printf(java.util.Locale.US, "f %d/%d %d/%d %d/%d%n",
                        p0 + vertexOffset, t0 + tcOffset,
                        p1 + vertexOffset, t1 + tcOffset,
                        p2 + vertexOffset, t2 + tcOffset);
                }

                System.err.println("DEBUG OBJ: invalidFaces=" + invalidFaces + " goodFaces=" + (numFaces - invalidFaces));
                vertexOffset += numVerts;
                tcOffset += numTCs;
                terrainCount++;
            }

            int finalTerrainCount = terrainCount;
            System.err.println("DEBUG OBJ: Total terrain meshes exported: " + finalTerrainCount + " texture=" + hasTexture);
            pw.println("# Total meshes: " + finalTerrainCount);

            String texName = hasTexture ? pngFile.getName() : "";
            Platform.runLater(() -> showAlert("Export Complete",
                "3D model exported to:\n" + file.getAbsolutePath() + (hasTexture ? "\nTexture: " + texName : "")));
        } catch (Exception ex) {
            System.err.println("DEBUG OBJ ERROR: " + ex.getMessage());
            ex.printStackTrace();
            Platform.runLater(() -> showError("Export Error", ex.getMessage() + " - check console for details"));
        }
    }

    // ─── TIFF → OBJ direct high-fidelity export ────────────────────────────────

    private void setupTiffToOBJ() {
        if (btnTiffToOBJ == null) return;
        btnTiffToOBJ.setTooltip(new Tooltip("Importar GeoTIFF y convertir a OBJ con resolución nativa (sin pérdida de detalle)"));
        btnTiffToOBJ.setOnAction(e -> exportTiffDirectToOBJ());
    }

    private void exportTiffDirectToOBJ() {
        FileChooser fcIn = new FileChooser();
        fcIn.setTitle("Seleccionar GeoTIFF para convertir");
        fcIn.getExtensionFilters().addAll(
            new FileChooser.ExtensionFilter("GeoTIFF", "*.tif", "*.tiff", "*.TIF", "*.TIFF"),
            new FileChooser.ExtensionFilter("Todos los archivos", "*.*")
        );
        File tiffFile = fcIn.showOpenDialog(btnTiffToOBJ.getScene().getWindow());
        if (tiffFile == null) return;

        // --- NEW: Ask for resolution to optimize file size ---
        List<String> options = java.util.Arrays.asList(
            "Máxima (100% detalle) - Archivo muy pesado",
            "Alta (50% detalle) - 4x más ligero",
            "Media (25% detalle) - 16x más ligero",
            "Baja (12% detalle) - 64x más ligero"
        );
        javafx.scene.control.ChoiceDialog<String> dialog = new javafx.scene.control.ChoiceDialog<>(options.get(1), options);
        dialog.setTitle("Optimización de Tamaño");
        dialog.setHeaderText("El archivo original puede ser muy grande (GBs).\nSeleccione el nivel de detalle deseado:");
        dialog.setContentText("Resolución:");
        java.util.Optional<String> result = dialog.showAndWait();
        if (!result.isPresent()) return;

        final int step;
        String choice = result.get();
        if (choice.startsWith("Máxima")) step = 1;
        else if (choice.startsWith("Alta")) step = 2;
        else if (choice.startsWith("Media")) step = 4;
        else step = 8;

        FileChooser fcOut = new FileChooser();
        fcOut.setTitle("Guardar OBJ");
        fcOut.getExtensionFilters().add(new FileChooser.ExtensionFilter("OBJ File", "*.obj"));
        String baseName = tiffFile.getName().replaceAll("(?i)\\.tiff?$", "");
        fcOut.setInitialFileName(baseName + (step == 1 ? "_hifi" : "_opt") + ".obj");
        File objFile = fcOut.showSaveDialog(btnTiffToOBJ.getScene().getWindow());
        if (objFile == null) return;

        btnTiffToOBJ.setDisable(true);
        btnTiffToOBJ.setText("Preparando...");

        final File finalTiff = tiffFile;
        final File finalObj  = objFile;

        tileExecutor.submit(() -> {
            org.geotools.gce.geotiff.GeoTiffReader reader = null;
            org.geotools.coverage.grid.GridCoverage2D coverage = null;
            try {
                System.err.println("TIFF→OBJ: Abriendo " + finalTiff.getName() + " con paso " + step);

                org.geotools.util.factory.Hints hints = new org.geotools.util.factory.Hints();
                hints.put(org.geotools.util.factory.Hints.FORCE_LONGITUDE_FIRST_AXIS_ORDER, Boolean.TRUE);
                hints.put(org.geotools.util.factory.Hints.USE_JAI_IMAGEREAD, Boolean.FALSE);

                reader   = new org.geotools.gce.geotiff.GeoTiffReader(finalTiff, hints);
                coverage = reader.read(null);
                
                java.awt.image.RenderedImage ri = coverage.getRenderedImage();
                final int rW = ri.getWidth(), rH = ri.getHeight();
                
                // --- Optimized Read: Only what we need for the step ---
                final int outW = (rW + step - 1) / step;
                final int outH = (rH + step - 1) / step;
                final float[] elev = new float[outW * outH];

                System.err.println("TIFF→OBJ: Procesando grid de " + outW + "x" + outH);
                Platform.runLater(() -> btnTiffToOBJ.setText("Muestreando..."));

                int minTX = ri.getMinTileX(), nTX = ri.getNumXTiles();
                int minTY = ri.getMinTileY(), nTY = ri.getNumYTiles();
                int ox = ri.getMinX(), oy = ri.getMinY();

                for (int ti = 0; ti < nTX; ti++) {
                    for (int tj = 0; tj < nTY; tj++) {
                        java.awt.image.Raster tile = ri.getTile(minTX + ti, minTY + tj);
                        if (tile == null) continue;
                        int x0 = Math.max(tile.getMinX(), ox);
                        int y0 = Math.max(tile.getMinY(), oy);
                        int x1 = Math.min(tile.getMinX() + tile.getWidth(),  ox + rW);
                        int y1 = Math.min(tile.getMinY() + tile.getHeight(), oy + rH);
                        
                        for (int y = y0; y < y1; y++) {
                            if ((y - oy) % step != 0) continue;
                            int outY = (y - oy) / step;
                            for (int x = x0; x < x1; x++) {
                                if ((x - ox) % step != 0) continue;
                                int outX = (x - ox) / step;
                                elev[outY * outW + outX] = tile.getSampleFloat(x, y, 0);
                            }
                        }
                    }
                }

                // ── Find min/max ──
                float minV = Float.MAX_VALUE, maxV = -Float.MAX_VALUE;
                for (float v : elev) {
                    if (Float.isNaN(v) || v <= -9999f || v <= -1e6f) continue;
                    if (v < minV) minV = v;
                    if (v > maxV) maxV = v;
                }
                if (minV == Float.MAX_VALUE) { minV = 0; maxV = 1; }
                final float fMin = minV;
                final float fRange = (maxV - minV) < 1e-7f ? 1f : (maxV - minV);
                final float scaleY = 4.0f;

                // ── Normalize ──
                for (int i = 0; i < elev.length; i++) {
                    float v = elev[i];
                    elev[i] = (Float.isNaN(v) || v <= -9999f || v <= -1e6f)
                        ? 0f : (v - fMin) / fRange * scaleY;
                }

                org.opengis.geometry.Envelope env = coverage.getEnvelope();
                final float scaleX = 15.0f;
                final float scaleZ = (float)(scaleX * env.getSpan(1) / env.getSpan(0));

                coverage.dispose(true); reader.dispose();

                // ── WRITE OBJ ──
                try (java.io.BufferedOutputStream bos = new java.io.BufferedOutputStream(
                        new java.io.FileOutputStream(finalObj), 8 * 1024 * 1024)) {

                    writeOBJStr(bos, "# AeroMapGIS Optimized OBJ\n# Resolution: " + outW + "x" + outH + "\no terrain\n");

                    // Vertices (3 decimals)
                    for (int row = 0; row < outH; row++) {
                        if (row % 50 == 0) {
                            final int p = (row * 100) / outH;
                            Platform.runLater(() -> btnTiffToOBJ.setText(p + "%"));
                        }
                        float vz = scaleZ / 2f - (row / (float)(outH - 1)) * scaleZ;
                        for (int col = 0; col < outW; col++) {
                            float vx = (col / (float)(outW - 1)) * scaleX - scaleX / 2f;
                            writeOBJVertex(bos, vx, elev[row * outW + col], vz);
                        }
                    }

                    // Faces
                    Platform.runLater(() -> btnTiffToOBJ.setText("Caras..."));
                    for (int row = 0; row < outH - 1; row++) {
                        for (int col = 0; col < outW - 1; col++) {
                            int tl = row * outW + col + 1;
                            int tr = tl + 1;
                            int bl = (row + 1) * outW + col + 1;
                            int br = bl + 1;
                            writeOBJFace(bos, tl, bl, tr);
                            writeOBJFace(bos, tr, bl, br);
                        }
                    }
                }

                long sizeMB = finalObj.length() / (1024 * 1024);
                Platform.runLater(() -> {
                    btnTiffToOBJ.setDisable(false);
                    btnTiffToOBJ.setText("TIFF→OBJ");
                    showAlert("Exportación completada",
                        "OBJ optimizado: " + outW + "×" + outH + " vértices\n" +
                        "Paso de muestreo: " + step + "x" + step + "\n" +
                        "Tamaño final: " + (sizeMB > 1024 ? (sizeMB/1024.0 + " GB") : (sizeMB + " MB")));
                });

            } catch (Throwable ex) {
                ex.printStackTrace();
                Platform.runLater(() -> {
                    btnTiffToOBJ.setDisable(false);
                    btnTiffToOBJ.setText("TIFF→OBJ");
                    showError("Error", ex.getMessage());
                });
            }
        });
    }

    private static void writeOBJStr(java.io.OutputStream out, String s) throws java.io.IOException {
        out.write(s.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    }
    private static void writeOBJVertex(java.io.OutputStream out, float x, float y, float z) throws java.io.IOException {
        byte[] buf = new byte[64];
        int pos = 0;
        buf[pos++] = 'v'; buf[pos++] = ' ';
        pos = fmtF3(buf, pos, x); buf[pos++] = ' ';
        pos = fmtF3(buf, pos, y); buf[pos++] = ' ';
        pos = fmtF3(buf, pos, z); buf[pos++] = '\n';
        out.write(buf, 0, pos);
    }
    private static void writeOBJFace(java.io.OutputStream out, int a, int b, int c) throws java.io.IOException {
        byte[] buf = new byte[40];
        int pos = 0;
        buf[pos++] = 'f'; buf[pos++] = ' ';
        pos = fmtI(buf, pos, a); buf[pos++] = ' ';
        pos = fmtI(buf, pos, b); buf[pos++] = ' ';
        pos = fmtI(buf, pos, c); buf[pos++] = '\n';
        out.write(buf, 0, pos);
    }
    /** 3-decimal-place float */
    private static int fmtF3(byte[] buf, int pos, float val) {
        if (val < 0) { buf[pos++] = '-'; val = -val; }
        long scaled = Math.round((double)val * 1000.0);
        long ip = scaled / 1000, fp = scaled % 1000;
        pos = fmtI(buf, pos, (int) ip);
        buf[pos++] = '.';
        buf[pos++] = (byte)('0' + fp / 100);
        buf[pos++] = (byte)('0' + fp / 10 % 10);
        buf[pos++] = (byte)('0' + fp % 10);
        return pos;
    }
    private static int fmtI(byte[] buf, int pos, int val) {
        if (val == 0) { buf[pos++] = '0'; return pos; }
        int s = pos;
        while (val > 0) { buf[pos++] = (byte)('0' + val % 10); val /= 10; }
        for (int i = s, j = pos - 1; i < j; i++, j--) {
            byte t = buf[i]; buf[i] = buf[j]; buf[j] = t;
        }
        return pos;
    }



    private void rebuild3DContent() {
        if (scene3D != null) {
            build3DContent();
            resetCameraPosition();
        }
    }

    private void runAnalysis(RasterAnalysisService.AnalysisType type) {
        String selected = layerList.getSelectionModel().getSelectedItem();
        GeoTiffService.RasterData targetRaster = null;

        // Try to find the selected raster in the list
        if (selected != null) {
            for (GeoTiffService.RasterData rd : rasterLayers) {
                String fullName = "[Raster] " + rd.name;
                if (selected.equals(fullName) || selected.equals(rd.name)) {
                    targetRaster = rd;
                    break;
                }
            }
        }

        // If nothing selected or selection wasn't a raster, try to be smart
        if (targetRaster == null) {
            List<GeoTiffService.RasterData> availableRasters = new ArrayList<>();
            for (GeoTiffService.RasterData rd : rasterLayers) {
                if (rd.reader != null) availableRasters.add(rd);
            }

            if (availableRasters.isEmpty()) {
                showAlert("No Data", "No valid raster layers found for analysis. Please import a GeoTIFF first.");
                return;
            } else if (availableRasters.size() == 1) {
                targetRaster = availableRasters.get(0);
            } else {
                List<String> choices = new ArrayList<>();
                for (GeoTiffService.RasterData rd : availableRasters) choices.add(rd.name);
                ChoiceDialog<String> dialog = new ChoiceDialog<>(choices.get(0), choices);
                dialog.setTitle("Select Input Layer");
                dialog.setHeaderText("Multiple raster layers found.");
                dialog.setContentText("Choose the layer for " + type.name().toLowerCase() + " analysis:");
                java.util.Optional<String> result = dialog.showAndWait();
                if (result.isPresent()) {
                    for (GeoTiffService.RasterData rd : availableRasters) {
                        if (rd.name.equals(result.get())) { targetRaster = rd; break; }
                    }
                } else { return; }
            }
        }

        if (targetRaster == null) return;

        // Show configuration dialog
        RasterAnalysisService.AnalysisParams params = showAnalysisConfigDialog(type);
        if (params == null) return; // User cancelled

        final GeoTiffService.RasterData finalTarget = targetRaster;
        tileExecutor.submit(() -> {
            try {
                BufferedImage result = analysisService.performAnalysis(finalTarget, type, params);
                Platform.runLater(() -> {
                    if (result != null) {
                        String resultName = type.name() + " of " + finalTarget.name;
                        GeoTiffService.RasterData resultData = new GeoTiffService.RasterData(null, finalTarget.envelope, resultName);
                        resultData.cachedOverview = result;
                        resultData.overviewEnvelope = finalTarget.envelope;
                        rasterLayers.add(resultData);
                        layerList.getItems().add(0, resultName);
                        layerList.getSelectionModel().select(0);
                        drawMap(false);
                    } else {
                        showAlert("Analysis Failed", "Could not complete the analysis. Ensure the TIFF contains elevation data.");
                    }
                });
            } catch (Exception e) {
                Platform.runLater(() -> showAlert("Error", "An error occurred during analysis: " + e.getMessage()));
            }
        });
    }

    private RasterAnalysisService.AnalysisParams showAnalysisConfigDialog(RasterAnalysisService.AnalysisType type) {
        Dialog<RasterAnalysisService.AnalysisParams> dialog = new Dialog<>();
        dialog.setTitle(type.name() + " Configuration");
        dialog.setHeaderText("Set parameters for " + type.name().toLowerCase() + " analysis.");

        VBox content = new VBox(10);
        content.setPadding(new javafx.geometry.Insets(20));
        content.setMinWidth(300);

        RasterAnalysisService.AnalysisParams params = new RasterAnalysisService.AnalysisParams();

        // Common Z-Factor
        Label zLabel = new Label("Vertical Exaggeration (Z-Factor):");
        Slider zSlider = new Slider(0.1, 10.0, 1.0);
        zSlider.setShowTickLabels(true);
        zSlider.setShowTickMarks(true);
        content.getChildren().addAll(zLabel, zSlider);

        // Specific for Hillshade
        Slider azSlider = null;
        Slider altSlider = null;
        if (type == RasterAnalysisService.AnalysisType.HILLSHADE) {
            Label azLabel = new Label("Sun Azimuth (0-360°):");
            azSlider = new Slider(0, 360, 315);
            azSlider.setShowTickLabels(true);
            
            Label altLabel = new Label("Sun Altitude (0-90°):");
            altSlider = new Slider(0, 90, 45);
            altSlider.setShowTickLabels(true);
            
            content.getChildren().addAll(new Separator(), azLabel, azSlider, altLabel, altSlider);
        }

        dialog.getDialogPane().setContent(content);
        ButtonType okButton = new ButtonType("Run Analysis", ButtonBar.ButtonData.OK_DONE);
        dialog.getDialogPane().getButtonTypes().addAll(okButton, ButtonType.CANCEL);

        final Slider finalAz = azSlider;
        final Slider finalAlt = altSlider;
        
        dialog.setResultConverter(btn -> {
            if (btn == okButton) {
                params.zFactor = zSlider.getValue();
                if (finalAz != null) params.azimuth = finalAz.getValue();
                if (finalAlt != null) params.altitude = finalAlt.getValue();
                return params;
            }
            return null;
        });

        return dialog.showAndWait().orElse(null);
    }

    private void handleBuffer() {
        String selected = layerList.getSelectionModel().getSelectedItem();
        if (selected == null || !selected.contains("[Vector]")) {
            showAlert("Selection Required", "Please select a vector layer for buffering.");
            return;
        }
        
        VectorService.VectorData target = null;
        for (VectorService.VectorData v : vectorLayers) {
            String name = vectorNames.get(v);
            if (name != null && selected.contains(name)) { target = v; break; }
        }
        if (target == null) return;
        final VectorService.VectorData finalTarget = target;

        TextInputDialog dialog = new TextInputDialog("0.01");
        dialog.setTitle("Buffer Distance");
        dialog.setHeaderText("Specify the buffer distance (map units):");
        dialog.showAndWait().ifPresent(distStr -> {
            try {
                double dist = Double.parseDouble(distStr);
                VectorService.VectorData result = vectorService.buffer(finalTarget, dist);
                String name = "Buffer of " + vectorNames.get(finalTarget);
                vectorLayers.add(result);
                vectorNames.put(result, name);
                layerList.getItems().add(0, "[Vector] " + name);
                drawMap(false);
            } catch (Exception ex) {
                showAlert("Error", "Invalid distance format.");
            }
        });
    }

    private void handleClip() {
        showAlert("Tool Active", "Select a vector layer to clip, then draw a polygon to define the clipping area.");
    }

    private void handleHeatmap() {
        String selected = layerList.getSelectionModel().getSelectedItem();
        if (selected == null || !selected.contains("[Vector]")) {
            showAlert("Selection Required", "Please select a vector layer with points for the heatmap.");
            return;
        }

        VectorService.VectorData target = null;
        for (VectorService.VectorData v : vectorLayers) {
            String name = vectorNames.get(v);
            if (name != null && selected.contains(name)) { target = v; break; }
        }
        if (target == null) return;
        final VectorService.VectorData finalTarget = target;

        TextInputDialog dialog = new TextInputDialog("0.05");
        dialog.setTitle("Heatmap Radius");
        dialog.setHeaderText("Specify the kernel radius (map units):");
        dialog.showAndWait().ifPresent(radStr -> {
            try {
                double radius = Double.parseDouble(radStr);
                BufferedImage img = vectorService.generateHeatmap(finalTarget, 1024, 1024, radius);
                String name = "Heatmap of " + vectorNames.get(finalTarget);
                GeoTiffService.RasterData rd = new GeoTiffService.RasterData(null, finalTarget.envelope, name);
                rd.cachedOverview = img;
                rd.overviewEnvelope = finalTarget.envelope;
                rasterLayers.add(rd);
                layerList.getItems().add(0, "[Raster] " + name);
                drawMap(false);
            } catch (Exception ex) {
                showAlert("Error", "Invalid radius format.");
            }
        });
    }

    private void handleOneLayerOp(String op) {
        String selected = layerList.getSelectionModel().getSelectedItem();
        if (selected == null || !selected.contains("[Vector]")) {
            showAlert("Selection Required", "Please select a vector layer for " + op);
            return;
        }
        VectorService.VectorData target = getSelectedVectorData(selected);
        if (target == null) return;

        VectorService.VectorData result = null;
        switch(op) {
            case "Dissolve": result = vectorService.dissolve(target); break;
            case "Simplify": result = vectorService.simplify(target, 0.001); break;
            case "Centroids": result = vectorService.centroids(target); break;
            case "Convex Hull": result = vectorService.convexHull(target); break;
            case "Voronoi": result = vectorService.voronoi(target); break;
        }

        if (result != null) {
            String name = op + " of " + vectorNames.get(target);
            addVectorLayer(result, name);
        }
    }

    private void handleTwoLayerOp(String op) {
        String selected = layerList.getSelectionModel().getSelectedItem();
        if (selected == null || !selected.contains("[Vector]")) {
            showAlert("Selection Required", "Select the first vector layer.");
            return;
        }
        VectorService.VectorData a = getSelectedVectorData(selected);
        
        List<String> others = new ArrayList<>();
        for (VectorService.VectorData v : vectorLayers) {
            String n = vectorNames.get(v);
            if (!selected.contains(n)) others.add(n);
        }
        
        if (others.isEmpty()) {
            showAlert("Missing Layers", "You need at least two vector layers.");
            return;
        }

        ChoiceDialog<String> dialog = new ChoiceDialog<>(others.get(0), others);
        dialog.setTitle(op + " Operation");
        dialog.setHeaderText("Select the second layer:");
        dialog.showAndWait().ifPresent(choice -> {
            VectorService.VectorData b = null;
            for (VectorService.VectorData v : vectorLayers) {
                if (vectorNames.get(v).equals(choice)) { b = v; break; }
            }
            if (b != null) {
                VectorService.VectorData result = (op.equals("Union")) ? vectorService.union(a, b) : vectorService.erase(a, b);
                addVectorLayer(result, op + " Result");
            }
        });
    }

    private VectorService.VectorData getSelectedVectorData(String label) {
        if (label == null) return null;
        String cleanName = label.replace("[Vector] ", "").trim();
        for (VectorService.VectorData v : vectorLayers) {
            String name = vectorNames.get(v);
            if (name != null && name.trim().equals(cleanName)) return v;
        }
        return null;
    }

    private GeoTiffService.RasterData getSelectedRasterData(String label) {
        if (label == null) return null;
        String cleanName = label.replace("[Raster] ", "").trim();
        for (GeoTiffService.RasterData r : rasterLayers) {
            if (r.name != null && r.name.trim().equals(cleanName)) return r;
        }
        return null;
    }

    private void addVectorLayer(VectorService.VectorData data, String name) {
        vectorLayers.add(data);
        vectorNames.put(data, name);
        Platform.runLater(() -> {
            layerList.getItems().add(0, "[Vector] " + name);
            drawMap(false);
        });
    }

private void showLabelConfigDialog(String layerItem) {
        VectorService.VectorData vd = getSelectedVectorData(layerItem);
        if (vd == null) return;

        if (vd.attributes == null || vd.attributes.isEmpty()) {
            showAlert("No Attributes", "This layer has no attribute data to create labels.");
            return;
        }

        Map<String, Object> sampleAttrs = vd.attributes.get(0);
        List<String> fieldNames = new ArrayList<>(sampleAttrs.keySet());

        Dialog<Void> dialog = new Dialog<>();
        dialog.setTitle("Label: " + layerItem.replace("[Vector] ", ""));
        dialog.setHeaderText("Configure label for layer");

        GridPane grid = new GridPane();
        grid.setHgap(10);
        grid.setVgap(8);
        grid.setPadding(new javafx.geometry.Insets(15));

        int row = 0;

        Label lblField = new Label("Field:");
        ComboBox<String> cmbField = new ComboBox<>();
        cmbField.getItems().addAll(fieldNames);
        cmbField.setPrefWidth(200);
        if (!fieldNames.isEmpty()) cmbField.getSelectionModel().select(0);

        TextField txtExpr = new TextField();
        txtExpr.setPromptText("[FIELD_NAME]");
        if (vd.labelConfig != null) txtExpr.setText(vd.labelConfig.expression);
        else if (!fieldNames.isEmpty()) txtExpr.setText("[" + fieldNames.get(0) + "]");

        cmbField.setOnAction(e -> {
            String selected = cmbField.getSelectionModel().getSelectedItem();
            if (selected != null) txtExpr.setText("[" + selected + "]");
        });

        grid.add(lblField, 0, row);
        grid.add(cmbField, 1, row);
        row++;

        Label lblExpr = new Label("Expression:");
        grid.add(lblExpr, 0, row);
        grid.add(txtExpr, 1, row);
        row++;

        Label lblFontFamily = new Label("Font:");
        ComboBox<String> cmbFontFamily = new ComboBox<>();
        cmbFontFamily.setPrefWidth(280);
        java.util.List<String> families = javafx.scene.text.Font.getFamilies();
        cmbFontFamily.getItems().addAll(families);
        cmbFontFamily.getSelectionModel().select(vd.labelConfig != null ? vd.labelConfig.fontFamily : "Sans-Serif");
        if (!cmbFontFamily.getSelectionModel().isEmpty()) cmbFontFamily.setVisibleRowCount(Math.min(20, families.size()));
        grid.add(lblFontFamily, 0, row);
        grid.add(cmbFontFamily, 1, row);
        row++;

        Label lblFont = new Label("Size:");
        Slider slFont = new Slider(6, 36, vd.labelConfig != null ? vd.labelConfig.fontSize : 12);
        slFont.setPrefWidth(200);
        Label lblFontVal = new Label(String.valueOf((int)slFont.getValue()));
        slFont.valueProperty().addListener((o, a, v) -> lblFontVal.setText(String.valueOf((int)v.doubleValue())));
        grid.add(lblFont, 0, row);
        grid.add(slFont, 1, row);
        grid.add(lblFontVal, 2, row);
        row++;

        CheckBox chkBold = new CheckBox("Bold");
        CheckBox chkItalic = new CheckBox("Italic");
        if (vd.labelConfig != null) {
            chkBold.setSelected(vd.labelConfig.bold);
            chkItalic.setSelected(vd.labelConfig.italic);
        }
        grid.add(new Label("Style:"), 0, row);
        grid.add(new HBox(10, chkBold, chkItalic), 1, row);
        row++;

        Label lblPrio = new Label("Priority:");
        Slider slPrio = new Slider(0, 10, vd.labelConfig != null ? vd.labelConfig.priority : 5);
        slPrio.setPrefWidth(200);
        Label lblPrioVal = new Label(String.valueOf((int)slPrio.getValue()));
        slPrio.valueProperty().addListener((o, a, v) -> lblPrioVal.setText(String.valueOf((int)v.doubleValue())));
        grid.add(lblPrio, 0, row);
        grid.add(slPrio, 1, row);
        grid.add(lblPrioVal, 2, row);
        row++;

        grid.add(new Label("Text Color:"), 0, row);
        ColorPicker colorPicker = new ColorPicker();
        colorPicker.setValue(vd.labelConfig != null ? vd.labelConfig.color : javafx.scene.paint.Color.WHITE);
        grid.add(colorPicker, 1, row);
        row++;

        grid.add(new Label("Halo:"), 0, row);
        ColorPicker haloPicker = new ColorPicker();
        haloPicker.setValue(vd.labelConfig != null ? vd.labelConfig.haloColor : javafx.scene.paint.Color.BLACK);
        Slider slHalo = new Slider(0, 5, vd.labelConfig != null ? vd.labelConfig.haloRadius : 2.0);
        Label lblHaloVal = new Label(String.format("%.1f", slHalo.getValue()));
        slHalo.valueProperty().addListener((o, a, v) -> lblHaloVal.setText(String.format("%.1f", v.doubleValue())));
        grid.add(haloPicker, 1, row);
        grid.add(slHalo, 2, row);
        grid.add(lblHaloVal, 3, row);

        ScrollPane scroll = new ScrollPane(grid);
        scroll.setFitToWidth(true);
        scroll.setMaxHeight(400);

        dialog.getDialogPane().setContent(scroll);
        dialog.getDialogPane().setMinWidth(500);
        dialog.setResizable(true);
        ButtonType applyBtnType = new ButtonType("Apply", ButtonBar.ButtonData.OK_DONE);
        dialog.getDialogPane().getButtonTypes().addAll(applyBtnType, ButtonType.CANCEL);

        dialog.setResultConverter(btn -> {
            if (btn == applyBtnType) {
                LabelService.LabelConfig config = new LabelService.LabelConfig();
                config.expression = txtExpr.getText();
                config.fontFamily = cmbFontFamily.getSelectionModel().getSelectedItem();
                config.fontSize = slFont.getValue();
                config.bold = chkBold.isSelected();
                config.italic = chkItalic.isSelected();
                config.priority = (int) slPrio.getValue();
                config.color = colorPicker.getValue();
                config.haloColor = haloPicker.getValue();
                config.haloRadius = slHalo.getValue();
                config.enabled = true;

                labelConfigs.put(vd, config);
                vd.labelConfig = config;
                drawMap(false);
            }
            return null;
        });

        dialog.showAndWait();
    }

    private void openAttributeTable(VectorService.VectorData data, String layerName) {
        if (data.attributes == null || data.attributes.isEmpty()) {
            showAlert("No Attributes", "This layer has no attribute data.");
            return;
        }

        Stage stage = new Stage();
        stage.setTitle("Attribute Table: " + layerName);

        TableView<Map<String, Object>> table = new TableView<>();
        table.getSelectionModel().setSelectionMode(SelectionMode.MULTIPLE);
        // Create FilteredList to enable searching
        javafx.collections.ObservableList<Map<String, Object>> masterData = javafx.collections.FXCollections.observableArrayList(data.attributes);
        javafx.collections.transformation.FilteredList<Map<String, Object>> filteredData = new javafx.collections.transformation.FilteredList<>(masterData, p -> true);
        table.setItems(filteredData);

        // Create columns based on the first feature
        Map<String, Object> first = data.attributes.get(0);
        for (String key : first.keySet()) {
            TableColumn<Map<String, Object>, Object> column = new TableColumn<>(key);
            column.setCellValueFactory(cd -> new javafx.beans.property.SimpleObjectProperty<>(cd.getValue().get(key)));
            column.setPrefWidth(120);
            table.getColumns().add(column);
        }

        // Toolbar with Scissors button and Search
        Button btnCut = new Button();
        btnCut.setGraphic(new FontIcon("fas-cut"));
        btnCut.setTooltip(new Tooltip("Extract selected features to new layer"));
        btnCut.setStyle("-fx-background-color: #3c3c3c; -fx-text-fill: white; -fx-cursor: hand;");
        btnCut.setOnAction(e -> {
            List<Map<String, Object>> selectedItems = table.getSelectionModel().getSelectedItems();
            if (selectedItems.isEmpty()) {
                showAlert("Selection Empty", "Select at least one feature to extract.");
                return;
            }
            
            List<Geometry> newGeoms = new ArrayList<>();
            List<Map<String, Object>> newAttrs = new ArrayList<>();
            
            for (Map<String, Object> item : selectedItems) {
                // Find the index in the original master list to match geometry
                int idx = data.attributes.indexOf(item);
                if (idx >= 0 && idx < data.geometries.size()) {
                    newGeoms.add(data.geometries.get(idx));
                    newAttrs.add(new java.util.HashMap<>(item));
                }
            }
            
            if (!newGeoms.isEmpty()) {
                org.locationtech.jts.geom.Envelope combined = new org.locationtech.jts.geom.Envelope();
                for (Geometry g : newGeoms) combined.expandToInclude(g.getEnvelopeInternal());
                ReferencedEnvelope newEnv = new ReferencedEnvelope(combined, data.crs);
                
                VectorService.VectorData result = new VectorService.VectorData(newGeoms, newAttrs, newEnv, data.crs);
                addVectorLayer(result, "Extracted from " + layerName);
            }
        });

        // Search Field (Lupa)
        TextField txtSearch = new TextField();
        txtSearch.setPromptText("Search attributes...");
        txtSearch.setStyle("-fx-background-color: #3c3c3c; -fx-text-fill: white; -fx-border-color: #555; -fx-pref-width: 200;");
        
        FontIcon searchIcon = new FontIcon("fas-search");
        searchIcon.setIconColor(Color.LIGHTGRAY);
        
        txtSearch.textProperty().addListener((obs, old, newValue) -> {
            filteredData.setPredicate(item -> {
                if (newValue == null || newValue.isEmpty()) return true;
                String lower = newValue.toLowerCase();
                for (Object val : item.values()) {
                    if (val != null && val.toString().toLowerCase().contains(lower)) return true;
                }
                return false;
            });
        });

        HBox toolbar = new HBox(12, btnCut, new Separator(javafx.geometry.Orientation.VERTICAL), searchIcon, txtSearch);
        toolbar.setStyle("-fx-background-color: #2b2b2b; -fx-padding: 8;");
        toolbar.setAlignment(javafx.geometry.Pos.CENTER_LEFT);

        VBox root = new VBox(toolbar, table);
        VBox.setVgrow(table, javafx.scene.layout.Priority.ALWAYS);
        
        try {
            Scene scene = new Scene(root, 800, 500);
            String css = getClass().getResource("/com/aeromap/style.css") != null ? 
                         getClass().getResource("/com/aeromap/style.css").toExternalForm() : null;
            if (css != null) scene.getStylesheets().add(css);
            stage.setScene(scene);
            stage.show();
        } catch (Exception ex) {
            ex.printStackTrace();
            showAlert("Error", "Could not open attribute table: " + ex.getMessage());
        }
    }

    private void showAlert(String title, String content) {
        Alert alert = new Alert(Alert.AlertType.INFORMATION);
        alert.setTitle(title);
        alert.setHeaderText(null);
        alert.setContentText(content);
        alert.showAndWait();
    }

    private void reprojectLayer(String itemLabel, CoordinateReferenceSystem targetCRS) {
        try {
            if (itemLabel.contains("[Vector]")) {
                VectorService.VectorData v = getSelectedVectorData(itemLabel);
                if (v != null) {
                    if (v.crs != null) {
                        MathTransform transform = CRS.findMathTransform(v.crs, targetCRS, true);
                        List<Geometry> reprojected = new ArrayList<>();
                        for (Geometry g : v.geometries) reprojected.add(JTS.transform(g, transform));
                        v.geometries = reprojected;
                        v.envelope = new ReferencedEnvelope(JTS.transform(v.envelope, transform), targetCRS);
                    }
                    v.crs = targetCRS;
                }
            } else if (itemLabel.contains("[Raster]")) {
                for (GeoTiffService.RasterData rd : rasterLayers) {
                    if (itemLabel.contains(rd.name)) {
                        rd.envelope = new ReferencedEnvelope(rd.envelope.getMinX(), rd.envelope.getMaxX(), 
                                                           rd.envelope.getMinY(), rd.envelope.getMaxY(), 
                                                           targetCRS);
                        break;
                    }
                }
            }
            tileCache.clear();
            drawMap(false);
        } catch (Exception ex) {
            showError("Reprojection Error", "Could not reproject layer: " + ex.getMessage());
        }
    }

    private double worldToScreenX(double x, ReferencedEnvelope view) { return (x - view.getMinX()) / view.getWidth() * mapCanvas.getWidth(); }
    private double worldToScreenY(double y, ReferencedEnvelope view) { return (1 - (y - view.getMinY()) / view.getHeight()) * mapCanvas.getHeight(); }
    private double screenToWorldX(double sx) { return viewport.getMinX() + (sx / mapCanvas.getWidth()) * viewport.getWidth(); }
    private double screenToWorldY(double sy) { return viewport.getMinY() + (1 - sy / mapCanvas.getHeight()) * viewport.getHeight(); }

    // ─── OBJ Import ────────────────────────────────────────────────────────────

    private static class ImportedModel {
        final String name;
        final List<MeshView> meshViews;
        boolean visible;

        ImportedModel(String name, List<MeshView> meshViews) {
            this.name = name;
            this.meshViews = meshViews;
            this.visible = true;
        }
    }

    private void setupImportOBJ() {
        if (btnImportOBJ == null) return;
        btnImportOBJ.setTooltip(new Tooltip("Import OBJ 3D model into scene"));
        btnImportOBJ.setOnAction(e -> handleImportOBJ());
    }

    private void handleImportOBJ() {
        FileChooser fc = new FileChooser();
        fc.setTitle("Select OBJ File");
        fc.getExtensionFilters().addAll(
            new FileChooser.ExtensionFilter("Wavefront OBJ", "*.obj"),
            new FileChooser.ExtensionFilter("All Files", "*.*")
        );
        File file = fc.showOpenDialog(btnImportOBJ.getScene().getWindow());
        if (file == null) return;

        // Ask if user wants a flat base for 3D printing
        Alert baseDialog = new Alert(Alert.AlertType.CONFIRMATION);
        baseDialog.setTitle("3D Printing Base");
        baseDialog.setHeaderText("Add flat base for 3D printing?");
        baseDialog.setContentText("A flat base will be added underneath the model.");
        ButtonType btnYes = new ButtonType("Yes, add base");
        ButtonType btnNo = new ButtonType("No, just import");
        baseDialog.getButtonTypes().setAll(btnYes, btnNo);
        boolean addBase = baseDialog.showAndWait().orElse(btnNo) == btnYes;

        btnImportOBJ.setDisable(true);
        btnImportOBJ.setText("Loading OBJ...");

        final boolean fAddBase = addBase;
        new Thread(() -> {
            try {
                ObjImportService.ObjModel model = objImportService.loadObj(file);
                if (fAddBase) {
                    objImportService.addBaseToModel(model);
                }
                System.err.println("DEBUG OBJ IMPORT: loaded " + model.name + " with " + model.meshViews.size() + " mesh(es)");
                Platform.runLater(() -> {
                    ImportedModel imported = new ImportedModel(model.name, model.meshViews);
                    importedModels.add(imported);

                    if (is3DMode && scene3D != null) {
                        for (MeshView mv : model.meshViews) {
                            world3D.getChildren().add(mv);
                        }
                        resetCameraPosition();
                    }

                    layerList.getItems().add("[3D] " + model.name);

                    showAlert("OBJ Imported",
                        "Model: " + model.name + "\n" +
                        "Meshes: " + model.meshViews.size() + "\n" +
                        "Base: " + (fAddBase ? "Yes" : "No"));

                    btnImportOBJ.setDisable(false);
                    btnImportOBJ.setText("Import OBJ");
                });
            } catch (Exception ex) {
                Platform.runLater(() -> {
                    showError("OBJ Import Error", "Could not load OBJ file:\n" + ex.getMessage());
                    btnImportOBJ.setDisable(false);
                    btnImportOBJ.setText("Import OBJ");
                });
                ex.printStackTrace();
            }
        }).start();
    }

}
