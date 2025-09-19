// En producción, usa un puerto diferente para el portal
if (isProduction) {
    QRPortalWeb({ port: 3001 }); // Usar un puerto diferente
} else {
    QRPortalWeb();
}